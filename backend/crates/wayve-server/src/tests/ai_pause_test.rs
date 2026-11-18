// Tests for pausing AI: an organization's owner pauses the whole organization
// or one member, the platform owner pauses any organization, and a paused user
// gets no AI anywhere a feature asks for it.
#[cfg(test)]
mod tests {
    use crate::ai;
    use crate::ai::pause::{PauseReason, pause_reason};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    /// A fresh organization: its owner (id and bearer header) and one member.
    struct Org {
        id: i32,
        owner_bearer: String,
        member: i32,
        member_bearer: String,
    }

    async fn join(pool: &PgPool, org_id: i32, role: &str, account_type: &str) -> (i32, String) {
        let email = random_email();
        let uid = insert_local_user(pool, &email, "password123").await;
        sqlx::query("UPDATE users SET organization_id = $1, account_type = $2 WHERE id = $3")
            .bind(org_id)
            .bind(account_type)
            .bind(uid)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("attach user: {e}"));
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)",
        )
        .bind(org_id)
        .bind(uid)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("member row: {e}"));
        (uid, format!("Bearer {}", jwt_for(uid, &email)))
    }

    async fn make_org(pool: &PgPool) -> Org {
        let tag = random_email().replace(['@', '.'], "-");
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("Pause Org {tag}"))
        .bind(format!("pause-{tag}"))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("create org: {e}"));
        let (_, owner_bearer) = join(pool, id, "owner", "organization_admin").await;
        let (member, member_bearer) = join(pool, id, "member", "organization").await;
        Org {
            id,
            owner_bearer,
            member,
            member_bearer,
        }
    }

    async fn make_platform_owner(pool: &PgPool) -> (i32, String) {
        let email = random_email();
        let uid = insert_local_user(pool, &email, "password123").await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(uid)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, 'owner')
             ON CONFLICT (user_id) DO UPDATE SET role = 'owner'",
        )
        .bind(uid)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("platform member: {e}"));
        (uid, format!("Bearer {}", jwt_for(uid, &email)))
    }

    async fn cleanup(pool: &PgPool, org_id: i32) {
        let _ = sqlx::query("DELETE FROM organization_members WHERE organization_id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE organization_id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
    }

    macro_rules! app {
        ($pool:expr) => {
            actix_test::init_service(
                App::new()
                    .app_data(web::Data::new($pool.clone()))
                    .service(ai::pause::get_pause)
                    .service(ai::pause::put_org_pause)
                    .service(ai::pause::put_member_pause)
                    .service(ai::pause::put_platform_org_pause)
                    .service(ai::handler::ai_chat)
                    .service(ai::handler::get_ai_provider)
                    .service(ai::email_assist::email_assist),
            )
            .await
        };
    }

    macro_rules! put {
        ($app:expr, $uri:expr, $bearer:expr, $paused:expr) => {
            actix_test::call_service(
                &$app,
                actix_test::TestRequest::put()
                    .uri($uri)
                    .insert_header(("Authorization", $bearer.clone()))
                    .set_json(serde_json::json!({ "paused": $paused }))
                    .to_request(),
            )
            .await
        };
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn owner_pauses_one_member_then_the_whole_organization() {
        let previous_key = std::env::var("ANTHROPIC_API_KEY").ok();
        unsafe {
            std::env::set_var("ANTHROPIC_API_KEY", "sk-env-test");
        }
        let pool = test_pool().await;
        let org = make_org(&pool).await;
        let other = make_org(&pool).await;
        let app = app!(pool);

        // A member cannot pause anything, and the owner cannot reach into
        // another organization.
        assert_eq!(
            put!(app, "/ai/pause", org.member_bearer, true).status(),
            StatusCode::FORBIDDEN
        );
        let foreign = format!("/ai/pause/members/{}", other.member);
        assert_eq!(
            put!(app, &foreign, org.owner_bearer, true).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            pause_reason(&pool, other.member)
                .await
                .unwrap_or_else(|e| panic!("pause_reason: {e}")),
            None
        );

        // One member.
        let uri = format!("/ai/pause/members/{}", org.member);
        assert_eq!(
            put!(app, &uri, org.owner_bearer, true).status(),
            StatusCode::OK
        );
        assert_eq!(
            pause_reason(&pool, org.member)
                .await
                .unwrap_or_else(|e| panic!("pause_reason: {e}")),
            Some(PauseReason::Member)
        );
        // Nothing resolves for them, which is what covers every AI feature.
        assert!(
            ai::provider::resolve_ai_for_user(&pool, org.member)
                .await
                .unwrap_or_else(|e| panic!("resolve: {e}"))
                .is_none()
        );

        // Chat and email assist say why, and never reach a provider.
        let req = actix_test::TestRequest::post()
            .uri("/ai/chat")
            .insert_header(("Authorization", org.member_bearer.clone()))
            .set_json(serde_json::json!({ "messages": [{ "role": "user", "content": "hi" }] }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert_eq!(body["ai_paused"], "member");
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|m| m.contains("paused for your account"))
        );

        let req = actix_test::TestRequest::post()
            .uri("/ai/email-assist")
            .insert_header(("Authorization", org.member_bearer.clone()))
            .set_json(serde_json::json!({ "action": "improve", "text": "hello" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        let req = actix_test::TestRequest::get()
            .uri("/ai/provider")
            .insert_header(("Authorization", org.member_bearer.clone()))
            .to_request();
        let body: serde_json::Value =
            actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
        assert_eq!(body["paused"], "member");
        assert!(body["provider"].is_null());

        // The owner's view lists the member as paused.
        let req = actix_test::TestRequest::get()
            .uri("/ai/pause")
            .insert_header(("Authorization", org.owner_bearer.clone()))
            .to_request();
        let body: serde_json::Value =
            actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
        assert_eq!(body["scope"], "organization");
        assert_eq!(body["paused"], false);
        let members = body["members"]
            .as_array()
            .unwrap_or_else(|| panic!("members is not an array"));
        assert_eq!(members.len(), 2);
        assert_eq!(members[0]["user_id"], org.member);
        assert_eq!(members[0]["paused"], true);

        // Resumed, then the whole organization.
        assert_eq!(
            put!(app, &uri, org.owner_bearer, false).status(),
            StatusCode::OK
        );
        assert!(
            ai::provider::resolve_ai_for_user(&pool, org.member)
                .await
                .unwrap_or_else(|e| panic!("resolve: {e}"))
                .is_some()
        );
        assert_eq!(
            put!(app, "/ai/pause", org.owner_bearer, true).status(),
            StatusCode::OK
        );
        assert_eq!(
            pause_reason(&pool, org.member)
                .await
                .unwrap_or_else(|e| panic!("pause_reason: {e}")),
            Some(PauseReason::Organization)
        );
        // The other organization is untouched.
        assert_eq!(
            pause_reason(&pool, other.member)
                .await
                .unwrap_or_else(|e| panic!("pause_reason: {e}")),
            None
        );

        drop(app);
        unsafe {
            match previous_key {
                Some(key) => std::env::set_var("ANTHROPIC_API_KEY", key),
                None => std::env::remove_var("ANTHROPIC_API_KEY"),
            }
        }
        cleanup(&pool, org.id).await;
        cleanup(&pool, other.id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn platform_owner_pauses_an_organization_its_owner_cannot_resume() {
        let pool = test_pool().await;
        let org = make_org(&pool).await;
        let (platform_owner, platform_bearer) = make_platform_owner(&pool).await;
        let app = app!(pool);
        let uri = format!("/ai/pause/organizations/{}", org.id);

        // Only the platform owner may use the per-organization switch.
        assert_eq!(
            put!(app, &uri, org.owner_bearer, true).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            put!(app, "/ai/pause/organizations/0", platform_bearer, true).status(),
            StatusCode::NOT_FOUND
        );

        assert_eq!(
            put!(app, &uri, platform_bearer, true).status(),
            StatusCode::OK
        );
        assert_eq!(
            pause_reason(&pool, org.member)
                .await
                .unwrap_or_else(|e| panic!("pause_reason: {e}")),
            Some(PauseReason::Platform)
        );

        // The organization's own switch is a different one: turning it off
        // leaves the platform's pause in place.
        assert_eq!(
            put!(app, "/ai/pause", org.owner_bearer, false).status(),
            StatusCode::OK
        );
        assert_eq!(
            pause_reason(&pool, org.member)
                .await
                .unwrap_or_else(|e| panic!("pause_reason: {e}")),
            Some(PauseReason::Platform)
        );
        let req = actix_test::TestRequest::get()
            .uri("/ai/pause")
            .insert_header(("Authorization", org.owner_bearer.clone()))
            .to_request();
        let body: serde_json::Value =
            actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
        assert_eq!(body["paused_by_platform"], true);

        // The platform owner finds it by name, paused.
        let req = actix_test::TestRequest::get()
            .uri("/ai/pause?q=Pause%20Org")
            .insert_header(("Authorization", platform_bearer.clone()))
            .to_request();
        let body: serde_json::Value =
            actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
        assert_eq!(body["scope"], "platform");
        let listed = body["organizations"]
            .as_array()
            .unwrap_or_else(|| panic!("organizations is not an array"))
            .iter()
            .find(|o| o["id"] == org.id)
            .unwrap_or_else(|| panic!("the paused organization should be listed"))
            .clone();
        assert_eq!(listed["paused"], true);
        assert_eq!(listed["members"], 2);

        assert_eq!(
            put!(app, &uri, platform_bearer, false).status(),
            StatusCode::OK
        );
        assert_eq!(
            pause_reason(&pool, org.member)
                .await
                .unwrap_or_else(|e| panic!("pause_reason: {e}")),
            None
        );

        drop(app);
        cleanup(&pool, org.id).await;
        let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
            .bind(platform_owner)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(platform_owner)
            .execute(&pool)
            .await;
    }
}
