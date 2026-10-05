// Login credential schemes: the browser sends a derived auth key instead of the
// password (scheme 2), legacy accounts upgrade on login, and prelogin never tells
// the browser to send a raw password to an account that can't take one. The
// server never derives auth keys itself, so the tests use arbitrary well-formed
// base64 values.
#[cfg(test)]
mod tests {
    use crate::routes::auth::{login, reset_password};
    use crate::routes::auth_scheme::{DerivedCredential, prelogin, validate_derived};
    use crate::routes::user::change_password;
    use crate::test_support::{
        insert_google_user, insert_local_user, jwt_for, random_email, test_pool,
    };
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
    use sqlx::PgPool;

    fn salt(fill: u8) -> String {
        B64.encode([fill; 16])
    }

    fn key(fill: u8) -> String {
        B64.encode([fill; 32])
    }

    fn cred(salt_fill: u8, key_fill: u8) -> serde_json::Value {
        serde_json::json!({ "auth_salt": salt(salt_fill), "auth_key": key(key_fill) })
    }

    async fn scheme_of(pool: &PgPool, user_id: i32) -> (i16, Option<String>) {
        sqlx::query_as("SELECT auth_scheme, auth_salt FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("read scheme: {e}"))
    }

    async fn cleanup(pool: &PgPool, ids: &[i32]) {
        for id in ids {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    macro_rules! app {
        ($pool:expr) => {
            actix_test::init_service(
                App::new().app_data(web::Data::new($pool.clone())).service(
                    web::scope("/api")
                        .service(login)
                        .service(prelogin)
                        .service(reset_password)
                        .service(change_password),
                ),
            )
            .await
        };
    }

    macro_rules! post {
        ($app:expr, $uri:expr, $body:expr) => {{
            let req = actix_test::TestRequest::post()
                .uri($uri)
                .set_json($body)
                .to_request();
            let res = actix_test::call_service(&$app, req).await;
            let status = res.status();
            let body: serde_json::Value = actix_test::read_body_json(res).await;
            (status, body)
        }};
    }

    #[test]
    fn raw_password_is_not_a_valid_derived_credential() {
        let bogus = DerivedCredential {
            auth_salt: salt(1),
            auth_key: "hunter2-but-plaintext".into(),
        };
        assert!(validate_derived(&bogus).is_err());
        let ok = DerivedCredential {
            auth_salt: salt(1),
            auth_key: key(2),
        };
        assert!(validate_derived(&ok).is_ok());
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn prelogin_hides_unknown_and_google_accounts_behind_fake_salts() {
        let pool = test_pool().await;
        let _ = jwt_for(0, "env@example.com");
        let app = app!(pool);

        let unknown = random_email();
        let (s1, a) = post!(
            app,
            "/api/auth/prelogin",
            serde_json::json!({ "email": unknown })
        );
        let (_, b) = post!(
            app,
            "/api/auth/prelogin",
            serde_json::json!({ "email": unknown })
        );
        assert_eq!(s1, StatusCode::OK);
        assert_eq!(a["scheme"], 2);
        assert_eq!(a["auth_salt"], b["auth_salt"], "fake salt must be stable");

        let google_email = random_email();
        let google_id = insert_google_user(&pool, &google_email).await;
        let (_, g) = post!(
            app,
            "/api/auth/prelogin",
            serde_json::json!({ "email": google_email })
        );
        assert_eq!(
            g["scheme"], 2,
            "a password-less account must never get scheme 1"
        );

        cleanup(&pool, &[google_id]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn legacy_login_upgrades_and_then_only_the_auth_key_works() {
        let pool = test_pool().await;
        let _ = jwt_for(0, "env@example.com");
        let app = app!(pool);
        let email = random_email();
        let id = insert_local_user(&pool, &email, "legacy-pass").await;

        let (_, pre) = post!(
            app,
            "/api/auth/prelogin",
            serde_json::json!({ "email": email })
        );
        assert_eq!(pre["scheme"], 1);

        let (status, _) = post!(
            app,
            "/api/login",
            serde_json::json!({ "email": email, "password": "legacy-pass", "upgrade": cred(7, 8) })
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(scheme_of(&pool, id).await, (2, Some(salt(7))));

        let (_, pre) = post!(
            app,
            "/api/auth/prelogin",
            serde_json::json!({ "email": email })
        );
        assert_eq!(pre["scheme"], 2);
        assert_eq!(pre["auth_salt"], salt(7));

        let (status, _) = post!(
            app,
            "/api/login",
            serde_json::json!({ "email": email, "password": "legacy-pass" })
        );
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "raw password must stop working"
        );

        let (status, _) = post!(
            app,
            "/api/login",
            serde_json::json!({ "email": email, "auth_key": key(9) })
        );
        assert_eq!(status, StatusCode::UNAUTHORIZED, "wrong auth key");

        let (status, _) = post!(
            app,
            "/api/login",
            serde_json::json!({ "email": email, "auth_key": key(8) })
        );
        assert_eq!(status, StatusCode::OK);

        cleanup(&pool, &[id]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn reset_password_with_derived_credential_stores_scheme_2() {
        let pool = test_pool().await;
        let _ = jwt_for(0, "env@example.com");
        let app = app!(pool);
        let email = random_email();
        let id = insert_local_user(&pool, &email, "old-pass").await;
        let token = format!("tok-{}", random_email());
        sqlx::query(
            "INSERT INTO password_reset_tokens (user_id, token, expires_at) \
             VALUES ($1, $2, NOW() + INTERVAL '10 minutes')",
        )
        .bind(id)
        .bind(&token)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert token: {e}"));

        let (status, _) = post!(
            app,
            "/api/reset-password",
            serde_json::json!({ "token": token, "new_credential": cred(3, 4) })
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(scheme_of(&pool, id).await, (2, Some(salt(3))));

        let (status, _) = post!(
            app,
            "/api/login",
            serde_json::json!({ "email": email, "auth_key": key(4) })
        );
        assert_eq!(status, StatusCode::OK);

        cleanup(&pool, &[id]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn change_password_on_scheme_2_needs_current_auth_key() {
        let pool = test_pool().await;
        let app = app!(pool);
        let email = random_email();
        let id = insert_local_user(&pool, &email, "old-pass").await;
        let token = jwt_for(id, &email);

        // Move to scheme 2 through a real login upgrade.
        let (status, _) = post!(
            app,
            "/api/login",
            serde_json::json!({ "email": email, "password": "old-pass", "upgrade": cred(1, 2) })
        );
        assert_eq!(status, StatusCode::OK);

        let change = |body: serde_json::Value| {
            actix_test::TestRequest::post()
                .uri("/api/profile/password")
                .insert_header(("Authorization", format!("Bearer {token}")))
                .set_json(body)
                .to_request()
        };

        // The legacy current-password field is not a valid proof any more.
        let res = actix_test::call_service(
            &app,
            change(serde_json::json!({
                "current_password": "old-pass",
                "new_credential": cred(5, 6)
            })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = actix_test::call_service(
            &app,
            change(serde_json::json!({
                "current_auth_key": key(2),
                "new_credential": cred(5, 6)
            })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(scheme_of(&pool, id).await, (2, Some(salt(5))));

        let (status, _) = post!(
            app,
            "/api/login",
            serde_json::json!({ "email": email, "auth_key": key(6) })
        );
        assert_eq!(status, StatusCode::OK);

        cleanup(&pool, &[id]).await;
    }
}
