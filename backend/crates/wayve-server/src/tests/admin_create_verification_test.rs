// The email-confirmation gate on admin-provisioned accounts: creating an
// account requires a 6-digit code mailed to the address, so a mistyped address
// cannot yield a dead but loginable account. Most tests seed
// `admin_create_verifications` directly and need no SMTP; the one test that
// proves the mail actually goes out drives the real send path and skips itself
// when MAILPIT_API is unset (CI sets it; see .github/workflows/smoke.yml).
#[cfg(test)]
mod tests {
    use crate::routes::user::{admin_create_user, admin_send_create_code};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};

    async fn make_platform_owner(pool: &PgPool, email: &str) -> i32 {
        let id = insert_local_user(pool, email, "password123").await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, 'owner') \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set platform owner: {e}"));
        id
    }

    /// Seeds a code as if it had been mailed. A negative `expires_in_minutes`
    /// back-dates `expires_at`, so an expired code can be simulated without
    /// waiting out the 15-minute TTL.
    async fn seed_code(
        pool: &PgPool,
        admin_id: i32,
        account_email: &str,
        code: &str,
        expires_in_minutes: i64,
    ) -> i32 {
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO admin_create_verifications \
               (requested_by, account_email, delivery_email, code, expires_at) \
             VALUES ($1, $2, $2, $3, NOW() + ($4 || ' minutes')::INTERVAL) RETURNING id",
        )
        .bind(admin_id)
        .bind(account_email)
        .bind(code)
        .bind(expires_in_minutes.to_string())
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("seed code: {e}"))
    }

    async fn user_id_for(pool: &PgPool, email: &str) -> Option<i32> {
        sqlx::query_scalar::<_, i32>("SELECT id FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(pool)
            .await
            .unwrap_or_else(|e| panic!("lookup user: {e}"))
    }

    async fn cleanup(pool: &PgPool, admin_id: i32, emails: &[&str]) {
        let _ = sqlx::query("DELETE FROM admin_create_verifications WHERE requested_by = $1")
            .bind(admin_id)
            .execute(pool)
            .await;
        for email in emails {
            if let Some(id) = user_id_for(pool, email).await {
                let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
                    .bind(id)
                    .execute(pool)
                    .await;
                let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                    .bind(id)
                    .execute(pool)
                    .await;
            }
        }
        let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
            .bind(admin_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(admin_id)
            .execute(pool)
            .await;
    }

    async fn create_user_request(
        pool: &PgPool,
        admin_id: i32,
        admin_email: &str,
        new_email: &str,
        code: Option<&str>,
    ) -> StatusCode {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(admin_create_user),
        )
        .await;

        let mut body = serde_json::json!({
            "email": new_email,
            "password": "password123",
            "account_type": "platform_admin",
            "role": "member",
        });
        if let Some(code) = code {
            body["verification_code"] = serde_json::json!(code);
        }

        let req = actix_test::TestRequest::post()
            .uri("/admin/users")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(admin_id, admin_email)),
            ))
            .set_json(&body)
            .to_request();
        actix_test::call_service(&app, req).await.status()
    }

    #[actix_web::test]
    async fn create_without_a_code_is_rejected_and_creates_nothing() {
        let pool = test_pool().await;
        let admin_email = random_email();
        let admin_id = make_platform_owner(&pool, &admin_email).await;
        let new_email = random_email();

        let status = create_user_request(&pool, admin_id, &admin_email, &new_email, None).await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "no code → 400");
        assert!(
            user_id_for(&pool, &new_email).await.is_none(),
            "no user may exist when the code gate rejected the request"
        );

        cleanup(&pool, admin_id, &[&new_email]).await;
    }

    #[actix_web::test]
    async fn wrong_code_is_rejected_bumps_attempts_and_creates_nothing() {
        let pool = test_pool().await;
        let admin_email = random_email();
        let admin_id = make_platform_owner(&pool, &admin_email).await;
        let new_email = random_email();
        let code_id = seed_code(&pool, admin_id, &new_email, "123456", 15).await;

        let status =
            create_user_request(&pool, admin_id, &admin_email, &new_email, Some("000000")).await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "wrong code → 400");
        assert!(
            user_id_for(&pool, &new_email).await.is_none(),
            "a wrong code must not create the account"
        );

        let attempts: i32 =
            sqlx::query("SELECT attempts FROM admin_create_verifications WHERE id = $1")
                .bind(code_id)
                .fetch_one(&pool)
                .await
                .map(|r| r.get("attempts"))
                .unwrap_or_else(|e| panic!("read attempts: {e}"));
        assert_eq!(attempts, 1, "a wrong guess must be counted");

        cleanup(&pool, admin_id, &[&new_email]).await;
    }

    #[actix_web::test]
    async fn expired_code_is_rejected() {
        let pool = test_pool().await;
        let admin_email = random_email();
        let admin_id = make_platform_owner(&pool, &admin_email).await;
        let new_email = random_email();
        // The negative TTL puts expiry one minute in the past.
        seed_code(&pool, admin_id, &new_email, "123456", -1).await;

        let status =
            create_user_request(&pool, admin_id, &admin_email, &new_email, Some("123456")).await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "expired code → 400");
        assert!(
            user_id_for(&pool, &new_email).await.is_none(),
            "an expired code must not create the account"
        );

        cleanup(&pool, admin_id, &[&new_email]).await;
    }

    #[actix_web::test]
    async fn exhausted_attempts_burn_the_code() {
        let pool = test_pool().await;
        let admin_email = random_email();
        let admin_id = make_platform_owner(&pool, &admin_email).await;
        let new_email = random_email();
        let code_id = seed_code(&pool, admin_id, &new_email, "123456", 15).await;
        // Five is the attempt ceiling (MAX_VERIFY_ATTEMPTS), so even the correct
        // code below must now be refused.
        sqlx::query("UPDATE admin_create_verifications SET attempts = 5 WHERE id = $1")
            .bind(code_id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("set attempts: {e}"));

        let status =
            create_user_request(&pool, admin_id, &admin_email, &new_email, Some("123456")).await;

        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "burned code → 429");
        assert!(user_id_for(&pool, &new_email).await.is_none());

        let used: Option<chrono::DateTime<chrono::Utc>> =
            sqlx::query("SELECT used_at FROM admin_create_verifications WHERE id = $1")
                .bind(code_id)
                .fetch_one(&pool)
                .await
                .map(|r| r.get("used_at"))
                .unwrap_or_else(|e| panic!("read used_at: {e}"));
        assert!(used.is_some(), "an over-guessed code must be burned");

        cleanup(&pool, admin_id, &[&new_email]).await;
    }

    #[actix_web::test]
    async fn correct_code_creates_a_verified_user_and_is_single_use() {
        let pool = test_pool().await;
        let admin_email = random_email();
        let admin_id = make_platform_owner(&pool, &admin_email).await;
        let new_email = random_email();
        seed_code(&pool, admin_id, &new_email, "424242", 15).await;

        let status =
            create_user_request(&pool, admin_id, &admin_email, &new_email, Some("424242")).await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "correct code → account created"
        );

        let row = sqlx::query("SELECT id, email_verified FROM users WHERE email = $1")
            .bind(&new_email)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("created user missing: {e}"));
        assert!(
            row.get::<bool, _>("email_verified"),
            "the address was just proven — the user must not hit the unverified-login gate"
        );

        // The code is burned on use, so replaying it mints no second account.
        let second_email = random_email();
        let status =
            create_user_request(&pool, admin_id, &admin_email, &second_email, Some("424242")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "replayed code → 400");
        assert!(user_id_for(&pool, &second_email).await.is_none());

        cleanup(&pool, admin_id, &[&new_email, &second_email]).await;
    }

    #[actix_web::test]
    async fn a_code_is_scoped_to_the_admin_who_requested_it() {
        let pool = test_pool().await;
        let admin_a_email = random_email();
        let admin_a = make_platform_owner(&pool, &admin_a_email).await;
        let admin_b_email = random_email();
        let admin_b = make_platform_owner(&pool, &admin_b_email).await;
        let new_email = random_email();

        // Admin A requests the code, so admin B cannot spend it even knowing
        // the digits.
        seed_code(&pool, admin_a, &new_email, "555555", 15).await;

        let status =
            create_user_request(&pool, admin_b, &admin_b_email, &new_email, Some("555555")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "other admin's code → 400");
        assert!(user_id_for(&pool, &new_email).await.is_none());

        cleanup(&pool, admin_a, &[&new_email]).await;
        cleanup(&pool, admin_b, &[]).await;
    }

    // Drives the real SMTP send path against Mailpit, so it skips itself when
    // Mailpit is unconfigured. It is #[serial] because it mutates process env.
    #[actix_web::test]
    #[serial_test::serial]
    async fn send_code_mails_a_code_and_refuses_an_existing_email() {
        let Ok(smtp_host) = std::env::var("MAILPIT_SMTP_HOST") else {
            eprintln!("skipping: MAILPIT_SMTP_HOST unset");
            return;
        };
        let smtp_port = std::env::var("MAILPIT_SMTP_PORT").unwrap_or_else(|_| "1025".to_string());
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe {
            std::env::set_var("SMTP_HOST", &smtp_host);
            std::env::set_var("SMTP_PORT", &smtp_port);
            std::env::set_var("SMTP_USER", "test@fluxze.com");
            std::env::set_var("SMTP_PASS", "test");
            std::env::set_var("SMTP_FROM", "no-reply@fluxze.com");
        }

        let pool = test_pool().await;
        let admin_email = random_email();
        let admin_id = make_platform_owner(&pool, &admin_email).await;
        let new_email = random_email();

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(admin_send_create_code),
        )
        .await;
        let token = jwt_for(admin_id, &admin_email);

        let send = |account: String, delivery: String, token: String| {
            actix_test::TestRequest::post()
                .uri("/admin/users/send-code")
                .insert_header(("Authorization", format!("Bearer {token}")))
                .set_json(serde_json::json!({
                    "account_email": account,
                    "delivery_email": delivery,
                }))
                .to_request()
        };

        // The account address may be a synthetic org domain with no inbox, so
        // the code is delivered to a different, reachable address.
        let delivery = random_email();
        let resp = actix_test::call_service(
            &app,
            send(new_email.clone(), delivery.clone(), token.clone()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK, "code should be mailed");

        let row = sqlx::query(
            "SELECT code, delivery_email FROM admin_create_verifications \
             WHERE requested_by = $1 AND account_email = $2 AND used_at IS NULL",
        )
        .bind(admin_id)
        .bind(&new_email)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("code row missing: {e}"));
        assert_eq!(row.get::<String, _>("code").len(), 6, "6-digit code");
        assert_eq!(
            row.get::<String, _>("delivery_email"),
            delivery,
            "the code goes to the delivery address, not the account address"
        );

        // An address that already has an account is refused before any code is
        // mailed.
        let resp = actix_test::call_service(
            &app,
            send(admin_email.clone(), admin_email.clone(), token.clone()),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::CONFLICT,
            "existing email → 409, no code sent"
        );

        cleanup(&pool, admin_id, &[&new_email]).await;
    }
}
