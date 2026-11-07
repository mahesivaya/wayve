// Who may DM whom (directory_scope::dm_allowed): same scope only, except that
// platform support may talk with personal accounts and organization admins in
// both directions. Pins the rule matrix, the email lookup's `can_message`, the
// people list showing support to customers, and that a refused DM comes back
// to the sender as `send_failed` instead of vanishing.
#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use crate::chat::handler::chat_ws;
    use crate::directory_scope::dm_allowed;
    use crate::routes::user::{get_all_users, get_user_by_email};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as web_test, web};
    use awc::ws;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::Value;
    use sqlx::PgPool;
    use std::time::Duration;

    fn ensure_aes_key() {
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
    }

    struct People {
        personal_a: i32,
        personal_b: i32,
        org1_admin: i32,
        org1_member: i32,
        org2_admin: i32,
        platform_admin: i32,
        support: i32,
        orgs: Vec<i32>,
    }

    impl People {
        fn ids(&self) -> Vec<i32> {
            vec![
                self.personal_a,
                self.personal_b,
                self.org1_admin,
                self.org1_member,
                self.org2_admin,
                self.platform_admin,
                self.support,
            ]
        }
    }

    async fn exec(pool: &PgPool, sql: &str, a: i32, b: Option<i32>) {
        let mut q = sqlx::query(sql).bind(a);
        if let Some(b) = b {
            q = q.bind(b);
        }
        q.execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    async fn org(pool: &PgPool) -> i32 {
        sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(format!("org-{}", random_email()))
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("org: {e}"))
    }

    async fn org_user(pool: &PgPool, org_id: i32, account_type: &str) -> i32 {
        let id = insert_local_user(pool, &random_email(), "pw").await;
        sqlx::query("UPDATE users SET account_type = $1, organization_id = $2 WHERE id = $3")
            .bind(account_type)
            .bind(org_id)
            .bind(id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("org user: {e}"));
        id
    }

    async fn platform_user(pool: &PgPool, role: &str) -> i32 {
        let id = insert_local_user(pool, &random_email(), "pw").await;
        exec(
            pool,
            "UPDATE users SET account_type = 'platform_admin' WHERE id = $1",
            id,
            None,
        )
        .await;
        sqlx::query("INSERT INTO platform_members (user_id, role) VALUES ($1, $2)")
            .bind(id)
            .bind(role)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("platform role: {e}"));
        id
    }

    async fn people(pool: &PgPool) -> People {
        let (org1, org2) = (org(pool).await, org(pool).await);
        People {
            personal_a: insert_local_user(pool, &random_email(), "pw").await,
            personal_b: insert_local_user(pool, &random_email(), "pw").await,
            org1_admin: org_user(pool, org1, "organization_admin").await,
            org1_member: org_user(pool, org1, "organization").await,
            org2_admin: org_user(pool, org2, "organization_admin").await,
            platform_admin: platform_user(pool, "admin").await,
            support: platform_user(pool, "support").await,
            orgs: vec![org1, org2],
        }
    }

    async fn cleanup(pool: &PgPool, p: &People) {
        for id in p.ids() {
            let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
                .bind(id)
                .execute(pool)
                .await;
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
        for id in &p.orgs {
            let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    async fn allowed(pool: &PgPool, a: i32, b: i32) -> bool {
        sqlx::query_scalar(&format!(
            "SELECT {} FROM users a, users b WHERE a.id = $1 AND b.id = $2",
            dm_allowed("a", "b")
        ))
        .bind(a)
        .bind(b)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("dm_allowed: {e}"))
    }

    #[actix_web::test]
    async fn the_rule_matrix() {
        let pool = test_pool().await;
        let p = people(&pool).await;

        let cases = [
            ("personal ↔ personal", p.personal_a, p.personal_b, true),
            ("same org", p.org1_admin, p.org1_member, true),
            ("other org", p.org1_admin, p.org2_admin, false),
            ("platform ↔ platform", p.platform_admin, p.support, true),
            ("personal ↔ org", p.personal_a, p.org1_admin, false),
            (
                "personal ↔ platform (non-support)",
                p.personal_a,
                p.platform_admin,
                false,
            ),
            (
                "org admin ↔ platform (non-support)",
                p.org1_admin,
                p.platform_admin,
                false,
            ),
            ("support ↔ personal", p.support, p.personal_a, true),
            ("support ↔ org admin", p.support, p.org1_admin, true),
            (
                "support ↔ another org's admin",
                p.support,
                p.org2_admin,
                true,
            ),
            (
                "support ↔ org member (not admin)",
                p.support,
                p.org1_member,
                false,
            ),
        ];
        for (name, a, b, expected) in cases {
            assert_eq!(allowed(&pool, a, b).await, expected, "{name}");
            assert_eq!(allowed(&pool, b, a).await, expected, "{name} (reversed)");
        }

        cleanup(&pool, &p).await;
    }

    #[actix_web::test]
    async fn lookup_and_people_list_follow_the_rule() {
        let pool = test_pool().await;
        let p = people(&pool).await;
        let app = web_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_user_by_email)
                .service(get_all_users),
        )
        .await;

        let email_of = |id: i32| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id = $1")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap_or_else(|e| panic!("email: {e}"))
            }
        };
        let get = |uri: String, caller: i32| {
            web_test::TestRequest::get()
                .uri(&uri)
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(caller, "ignored@example.com")),
                ))
                .to_request()
        };

        // The org admin from the bug report: platform admin no, support yes.
        for (target, expected) in [(p.platform_admin, false), (p.support, true)] {
            let email = email_of(target).await;
            let resp =
                web_test::call_service(&app, get(format!("/users?email={email}"), p.org1_admin))
                    .await;
            assert_eq!(resp.status(), StatusCode::OK);
            let body: Value = web_test::read_body_json(resp).await;
            assert_eq!(body["can_message"], expected, "lookup of {target}");
        }

        // Customers see support in their people list without any prior DM.
        for caller in [p.personal_a, p.org1_admin] {
            let resp = web_test::call_service(&app, get("/users/all".into(), caller)).await;
            let body: Value = web_test::read_body_json(resp).await;
            let ids: Vec<i64> = body
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|u| u["id"].as_i64())
                .collect();
            assert!(ids.contains(&i64::from(p.support)), "{caller} sees support");
            assert!(
                !ids.contains(&i64::from(p.platform_admin)),
                "{caller} must not see other platform staff"
            );
        }

        // A regular org member does not.
        let resp = web_test::call_service(&app, get("/users/all".into(), p.org1_member)).await;
        let body: Value = web_test::read_body_json(resp).await;
        assert!(
            !body
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .any(|u| u["id"] == p.support),
            "org member must not see support"
        );

        cleanup(&pool, &p).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_refused_dm_comes_back_as_send_failed() {
        ensure_aes_key();
        let pool = test_pool().await;
        let p = people(&pool).await;
        let srv = {
            let pool = pool.clone();
            actix_test::start(move || {
                App::new()
                    .app_data(web::Data::new(pool.clone()))
                    .app_data(web::Data::new(None::<Cache>))
                    .route("/ws/chat", web::get().to(chat_ws))
            })
        };
        let token = jwt_for(p.org1_admin, "ignored@example.com");
        let (_, mut conn) = awc::Client::new()
            .ws(srv.url(&format!("/ws/chat?token={token}")))
            .connect()
            .await
            .unwrap_or_else(|e| panic!("ws connect: {e}"));

        let send = |to: i32, client_id: &str| {
            serde_json::json!({
                "sender_id": p.org1_admin,
                "receiver_id": to,
                "content": "WAYVE_CHAT_E2E_V1\npayload",
                "client_id": client_id,
            })
            .to_string()
        };
        // First frame for `client_id`, skipping presence and other traffic.
        async fn reply_for<S, E>(conn: &mut S, client_id: &str) -> Option<Value>
        where
            S: futures_util::Stream<Item = Result<ws::Frame, E>> + Unpin,
        {
            let deadline = actix_web::rt::time::Instant::now() + Duration::from_secs(5);
            loop {
                let left = deadline.saturating_duration_since(actix_web::rt::time::Instant::now());
                match actix_web::rt::time::timeout(left, conn.next()).await {
                    Ok(Some(Ok(ws::Frame::Text(bytes)))) => {
                        if let Ok(v) = serde_json::from_slice::<Value>(&bytes)
                            && v["client_id"] == client_id
                        {
                            return Some(v);
                        }
                    }
                    Ok(Some(Ok(_))) => continue,
                    _ => return None,
                }
            }
        }

        conn.send(ws::Message::Text(send(p.platform_admin, "refused").into()))
            .await
            .unwrap_or_else(|e| panic!("ws send: {e:?}"));
        let reply = reply_for(&mut conn, "refused")
            .await
            .unwrap_or_else(|| panic!("no reply to a refused DM"));
        assert_eq!(reply["type"], "send_failed");
        assert!(reply["message"].as_str().is_some_and(|m| !m.is_empty()));

        conn.send(ws::Message::Text(send(p.support, "allowed").into()))
            .await
            .unwrap_or_else(|e| panic!("ws send: {e:?}"));
        let reply = reply_for(&mut conn, "allowed")
            .await
            .unwrap_or_else(|| panic!("no echo for an allowed DM"));
        assert!(reply["message_id"].is_number(), "stored: {reply}");

        let stored: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE sender_id = $1 AND receiver_id = $2",
        )
        .bind(p.org1_admin)
        .bind(p.platform_admin)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("count: {e}"));
        assert_eq!(stored, 0, "a refused DM is never stored");

        drop(conn);
        cleanup(&pool, &p).await;
    }
}
