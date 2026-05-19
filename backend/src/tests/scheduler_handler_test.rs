#[cfg(test)]
mod tests {
    use crate::scheduler::handler::{create_meeting, delete_meeting, get_meetings, update_meeting};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test, web};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn set_env(key: &str, val: &str) {
        unsafe {
            std::env::set_var(key, val);
        }
    }

    fn set_zoom_creds() {
        set_env("ZOOM_ACCOUNT_ID", "acc-1");
        set_env("ZOOM_CLIENT_ID", "cid");
        set_env("ZOOM_CLIENT_SECRET", "csec");
    }

    /// Tomorrow's date so the "no past meetings" check passes.
    fn tomorrow_date_str() -> String {
        (chrono::Utc::now().date_naive() + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string()
    }

    #[actix_web::test]
    async fn meetings_endpoints_require_auth() {
        let pool = test_pool().await;
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool))
                .service(create_meeting)
                .service(get_meetings)
                .service(update_meeting)
                .service(delete_meeting),
        )
        .await;

        let resp =
            test::call_service(&app, test::TestRequest::get().uri("/meetings").to_request()).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let resp = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/meetings")
                // A well-formed body so the JSON extractor succeeds and the
                // request reaches the handler's auth check (an empty `{}`
                // would be rejected as a 400 before auth runs).
                .set_json(serde_json::json!({
                    "title": "x",
                    "date": tomorrow_date_str(),
                    "start": 9 * 60,
                    "end": 9 * 60 + 30,
                    "participants": ["x@example.com"],
                    "tz": "UTC",
                }))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let resp = test::call_service(
            &app,
            test::TestRequest::delete().uri("/meetings/1").to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn create_meeting_full_fanout_persists_meeting_and_calls_zoom_and_gmail() {
        let server = MockServer::start().await;
        set_zoom_creds();
        set_env(
            "ZOOM_OAUTH_TOKEN_URL",
            &format!("{}/oauth/token", server.uri()),
        );
        set_env("ZOOM_API_BASE", &server.uri());
        set_env("GMAIL_SEND_URL", &format!("{}/gmail/send", server.uri()));

        // Zoom OAuth + meeting create
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "zoom-tok",
                "expires_in": 3600,
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v2/users/me/meetings"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 99,
                "join_url": "https://zoom.example/j/99",
            })))
            .mount(&server)
            .await;

        // Gmail send (the spawned invite email will hit this)
        let gmail_mock = Mock::given(method("POST"))
            .and(path("/gmail/send"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "gmail-msg-1"
            })))
            .expect(1..)
            .named("gmail send")
            .mount_as_scoped(&server)
            .await;

        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "p").await;

        // Active gmail account is required for invite email to fire.
        sqlx::query(
            "INSERT INTO email_accounts (email, user_id, access_token, refresh_token, token_expiry, is_active)
             VALUES ($1,$2,$3,$4, NOW() + INTERVAL '1 hour', true)",
        )
        .bind(&email)
        .bind(user_id)
        .bind("active-gmail-tok")
        .bind("rt")
        .execute(&pool)
        .await
        .unwrap();

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_meeting),
        )
        .await;

        let payload = serde_json::json!({
            "title": "Standup",
            "date": tomorrow_date_str(),
            "start": 9 * 60,         // 09:00
            "end": 9 * 60 + 30,      // 09:30
            "participants": [format!("invitee-{}@example.com", uuid::Uuid::new_v4())],
            "tz": "UTC",
        });

        let req = test::TestRequest::post()
            .uri("/meetings")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(&payload)
            .to_request();

        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body: serde_json::Value = test::read_body_json(resp).await;
        let meeting_id = body["meeting_id"].as_i64().expect("meeting_id");

        // Meeting row exists and stores sensitive fields encrypted. The
        // legacy plaintext columns are intentionally blank/null for new rows.
        let row = sqlx::query(
            r#"
            SELECT title, title_encrypted, title_iv,
                   zoom_join_url, zoom_join_url_encrypted, zoom_join_url_iv
            FROM meetings
            WHERE id = $1
            "#,
        )
        .bind(meeting_id as i32)
        .fetch_one(&pool)
        .await
        .unwrap();
        let title: String = sqlx::Row::get(&row, "title");
        let title_encrypted: String = sqlx::Row::get(&row, "title_encrypted");
        let title_iv: String = sqlx::Row::get(&row, "title_iv");
        let join_url: Option<String> = sqlx::Row::try_get(&row, "zoom_join_url").unwrap_or(None);
        let join_url_encrypted: Option<String> =
            sqlx::Row::try_get(&row, "zoom_join_url_encrypted").unwrap_or(None);
        let join_url_iv: Option<String> =
            sqlx::Row::try_get(&row, "zoom_join_url_iv").unwrap_or(None);

        assert_eq!(title, "");
        assert_eq!(
            crate::security::encryption::decrypt(&title_iv, &title_encrypted).unwrap(),
            "Standup"
        );
        assert_eq!(join_url, None);
        assert_eq!(
            crate::security::encryption::decrypt(
                join_url_iv.as_deref().expect("zoom_join_url_iv"),
                join_url_encrypted
                    .as_deref()
                    .expect("zoom_join_url_encrypted"),
            )
            .unwrap(),
            "https://zoom.example/j/99"
        );

        // Participants row was inserted.
        let p_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM meeting_participants WHERE meeting_id = $1")
                .bind(meeting_id as i32)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(p_count, 1);

        // Wait briefly for the spawned invite email to fire, then drop the
        // scoped Mock — its Drop checks `expect(1..)` and panics if it
        // didn't see at least one request.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        drop(gmail_mock);

        sqlx::query("DELETE FROM meeting_participants WHERE meeting_id = $1")
            .bind(meeting_id as i32)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM meetings WHERE id = $1")
            .bind(meeting_id as i32)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM email_accounts WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .ok();
        crate::test_support::delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn create_meeting_continues_when_zoom_fails() {
        let server = MockServer::start().await;
        set_zoom_creds();
        set_env(
            "ZOOM_OAUTH_TOKEN_URL",
            &format!("{}/oauth/token", server.uri()),
        );
        set_env("ZOOM_API_BASE", &server.uri());
        set_env("GMAIL_SEND_URL", &format!("{}/gmail/send", server.uri()));

        // Zoom token fails — meeting should still be created without join URL.
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(500).set_body_string("zoom down"))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/send"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;

        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "p").await;

        sqlx::query(
            "INSERT INTO email_accounts (email, user_id, access_token, refresh_token, token_expiry, is_active)
             VALUES ($1,$2,$3,$4, NOW() + INTERVAL '1 hour', true)",
        )
        .bind(&email)
        .bind(user_id)
        .bind("tok")
        .bind("rt")
        .execute(&pool)
        .await
        .unwrap();

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_meeting),
        )
        .await;

        let payload = serde_json::json!({
            "title": "ZoomDown",
            "date": tomorrow_date_str(),
            "start": 10 * 60,
            "end": 10 * 60 + 30,
            "participants": ["alone@example.com"],
            "tz": "UTC",
        });

        let req = test::TestRequest::post()
            .uri("/meetings")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(&payload)
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body: serde_json::Value = test::read_body_json(resp).await;
        let meeting_id = body["meeting_id"].as_i64().unwrap() as i32;

        let join: Option<String> =
            sqlx::query_scalar("SELECT zoom_join_url FROM meetings WHERE id = $1")
                .bind(meeting_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(join.is_none(), "Zoom failure must leave join_url NULL");

        sqlx::query("DELETE FROM meeting_participants WHERE meeting_id = $1")
            .bind(meeting_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM meetings WHERE id = $1")
            .bind(meeting_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM email_accounts WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .ok();
        crate::test_support::delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn create_meeting_rejects_past_date() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "p").await;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_meeting),
        )
        .await;

        let yesterday = (chrono::Utc::now().date_naive() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        let payload = serde_json::json!({
            "title": "Past",
            "date": yesterday,
            "start": 9 * 60,
            "end": 10 * 60,
            "participants": ["x@example.com"],
            "tz": "UTC",
        });

        let req = test::TestRequest::post()
            .uri("/meetings")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(&payload)
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        crate::test_support::delete_user(&pool, user_id).await;
    }
}
