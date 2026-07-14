// The MCP integration: the Streamable-HTTP client handshake, and the gate on
// connecting, which only an enterprise org owner may pass and which stores the
// token encrypted at rest. The MCP server is mocked with wiremock, and the SSRF
// guard is relaxed via MCP_ALLOW_PRIVATE_HOSTS so the loopback mock is reachable.
#[cfg(test)]
mod tests {
    use crate::integrations;
    use crate::integrations::mcp::client::McpClient;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};
    use wayve_security::encryption::decrypt;
    use wiremock::matchers::{body_string_contains, method};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    /// Mounts the three JSON-RPC responses a handshake needs. One MCP endpoint
    /// serves many methods, so the mocks match on the `"method":"…"` substring
    /// of the request body. `notifications/initialized` is left unmounted and so
    /// 404s, which the client ignores because it is fire-and-forget.
    async fn mount_mcp_server(mock: &MockServer) {
        Mock::given(method("POST"))
            .and(body_string_contains("\"method\":\"initialize\""))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("Mcp-Session-Id", "sess-123")
                    .set_body_json(serde_json::json!({
                        "jsonrpc": "2.0", "id": 1,
                        "result": {
                            "protocolVersion": "2025-06-18",
                            "capabilities": { "tools": {} },
                            "serverInfo": { "name": "Acme DB", "version": "1.0" }
                        }
                    })),
            )
            .mount(mock)
            .await;
        Mock::given(method("POST"))
            .and(body_string_contains("\"method\":\"tools/list\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "jsonrpc": "2.0", "id": 100,
                "result": { "tools": [
                    {
                        "name": "query_orders",
                        "description": "Query the orders table",
                        "inputSchema": {
                            "type": "object",
                            "properties": { "id": { "type": "string" } },
                            "required": ["id"]
                        }
                    }
                ] }
            })))
            .mount(mock)
            .await;
        Mock::given(method("POST"))
            .and(body_string_contains("\"method\":\"tools/call\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "jsonrpc": "2.0", "id": 900,
                "result": {
                    "content": [{ "type": "text", "text": "order 5 shipped" }],
                    "isError": false
                }
            })))
            .mount(mock)
            .await;
    }

    /// Makes the user an owner of an enterprise-tier org, which is what the MCP
    /// connect gate requires. Returns the org id.
    async fn make_enterprise(pool: &PgPool, user_id: i32) -> i32 {
        let org_id: i32 = sqlx::query_scalar(
            "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("Ent Org {user_id}"))
        .bind(format!("ent-org-mcp-{user_id}"))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("create org: {e}"));
        sqlx::query(
            "UPDATE users SET organization_id = $1, account_type = 'organization_admin' WHERE id = $2",
        )
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("attach org: {e}"));
        let plan_id: i32 = sqlx::query_scalar("SELECT id FROM plans WHERE code = 'enterprise'")
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("enterprise plan id: {e}"));
        sqlx::query(
            "INSERT INTO subscriptions (organization_id, plan_id, status) VALUES ($1, $2, 'active')",
        )
        .bind(org_id)
        .bind(plan_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("subscription: {e}"));
        org_id
    }

    async fn cleanup(pool: &PgPool, user_id: i32, org_id: i32) {
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn client_handshake_lists_and_calls_tools() {
        let mock = MockServer::start().await;
        mount_mcp_server(&mock).await;

        // SAFETY: env mutation is serialized by #[serial]; CI also runs
        // --test-threads=1. The flag lets the loopback mock past the SSRF guard.
        unsafe {
            std::env::set_var("MCP_ALLOW_PRIVATE_HOSTS", "1");
        }

        let client = McpClient::new(&mock.uri(), Some("tok"));
        let name = client
            .initialize()
            .await
            .unwrap_or_else(|e| panic!("initialize: {e}"));
        assert_eq!(name.as_deref(), Some("Acme DB"));

        let tools = client
            .list_tools()
            .await
            .unwrap_or_else(|e| panic!("tools/list: {e}"));
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "query_orders");

        let result = client
            .call_tool("query_orders", serde_json::json!({ "id": "5" }))
            .await
            .unwrap_or_else(|e| panic!("tools/call: {e}"));
        assert_eq!(
            result["content"][0]["text"],
            serde_json::json!("order 5 shipped")
        );

        unsafe {
            std::env::remove_var("MCP_ALLOW_PRIVATE_HOSTS");
        }
        drop(mock);
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn gate_blocks_personal_and_allows_enterprise_connect() {
        let mock = MockServer::start().await;
        mount_mcp_server(&mock).await;

        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
            std::env::set_var("MCP_ALLOW_PRIVATE_HOSTS", "1");
        }

        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let bearer = format!("Bearer {}", jwt_for(user_id, &email));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(integrations::mcp::handler::list_connections)
                .service(integrations::mcp::handler::create_connection)
                .service(integrations::mcp::handler::update_connection)
                .service(integrations::mcp::handler::delete_connection),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/integrations/mcp/connections")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let org_id = make_enterprise(&pool, user_id).await;
        let req = actix_test::TestRequest::post()
            .uri("/integrations/mcp/connections")
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({
                "label": "Acme",
                "server_url": mock.uri(),
                "auth_token": "secret-token"
            }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let row = sqlx::query(
            "SELECT auth_token_iv, auth_token_encrypted, server_name, last_tool_count
               FROM mcp_connections WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("connection row: {e}"));
        let iv: String = row.get("auth_token_iv");
        let enc: String = row.get("auth_token_encrypted");
        assert_eq!(decrypt(&iv, &enc).unwrap_or_default(), "secret-token");
        let server_name: Option<String> = row.try_get("server_name").ok().flatten();
        assert_eq!(server_name.as_deref(), Some("Acme DB"));
        let tool_count: Option<i32> = row.try_get("last_tool_count").ok().flatten();
        assert_eq!(tool_count, Some(1));

        // The management list returns the connection but never its token.
        let req = actix_test::TestRequest::get()
            .uri("/integrations/mcp/connections")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body.as_array().map(|a| a.len()), Some(1));
        assert_eq!(body[0]["label"], serde_json::json!("Acme"));
        assert!(body[0].get("auth_token").is_none());
        assert!(body[0].get("auth_token_encrypted").is_none());

        drop(app);
        unsafe {
            std::env::remove_var("MCP_ALLOW_PRIVATE_HOSTS");
        }
        cleanup(&pool, user_id, org_id).await;
        drop(mock);
    }
}
