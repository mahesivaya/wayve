// Signup email-verification codes. Each code is valid for
// SIGNUP_CODE_TTL_SECONDS. A resend within SIGNUP_RESEND_WINDOW_SECONDS of the
// newest code emails that same code again; after it, a new code is issued and
// the earlier ones keep working until they expire, so any of the emails the
// user opens verifies. Wrong guesses are shared across the live codes. The
// send itself needs SMTP, which tests don't have, so issuing ignores its result
// and the tests check the stored codes and drive POST /verify-email.
#[cfg(test)]
mod tests {
    use crate::routes::auth::{
        MAX_VERIFY_ATTEMPTS, SIGNUP_CODE_TTL_SECONDS, issue_verification_code_and_email,
        verify_email,
    };
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    /// An unverified local user, as `/register` leaves one.
    async fn unverified_user(pool: &PgPool) -> (i32, String) {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        sqlx::query("UPDATE users SET email_verified = false WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("unverify: {e}"));
        (id, email)
    }

    /// (token, used) for every code of the user, oldest first.
    async fn codes(pool: &PgPool, user_id: i32) -> Vec<(String, bool)> {
        sqlx::query_as(
            "SELECT token, used_at IS NOT NULL FROM email_verification_tokens \
             WHERE user_id = $1 ORDER BY id",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("codes: {e}"))
    }

    async fn issue(pool: &PgPool, user_id: i32, email: &str) {
        // Err only means no SMTP here; the code rows are written before sending.
        let _ = issue_verification_code_and_email(pool, user_id, email).await;
    }

    /// Moves every code of the user `secs` into the past, as if issued earlier.
    async fn age_codes(pool: &PgPool, user_id: i32, secs: i64) {
        sqlx::query(
            "UPDATE email_verification_tokens \
             SET created_at = created_at - make_interval(secs => $2) WHERE user_id = $1",
        )
        .bind(user_id)
        .bind(secs as f64)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("age: {e}"));
    }

    async fn verify(pool: &PgPool, email: &str, code: &str) -> StatusCode {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(verify_email),
        )
        .await;
        let req = actix_test::TestRequest::post()
            .uri("/verify-email")
            .set_json(serde_json::json!({ "email": email, "code": code }))
            .to_request();
        actix_test::call_service(&app, req).await.status()
    }

    async fn is_verified(pool: &PgPool, user_id: i32) -> bool {
        sqlx::query_scalar("SELECT email_verified FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("verified: {e}"))
    }

    async fn cleanup(pool: &PgPool, user_id: i32) {
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_resend_inside_the_window_sends_the_same_code() {
        let pool = test_pool().await;
        let (user, email) = unverified_user(&pool).await;

        issue(&pool, user, &email).await;
        issue(&pool, user, &email).await;
        issue(&pool, user, &email).await;

        let rows = codes(&pool, user).await;
        assert_eq!(rows.len(), 1, "one code, re-sent: {rows:?}");
        assert!(!rows[0].1, "and still usable");

        let ttl: f64 = sqlx::query_scalar(
            "SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float8 \
             FROM email_verification_tokens WHERE user_id = $1",
        )
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("ttl: {e}"));
        assert!(
            (ttl - SIGNUP_CODE_TTL_SECONDS as f64).abs() < 5.0,
            "valid for about {SIGNUP_CODE_TTL_SECONDS}s, got {ttl}"
        );

        cleanup(&pool, user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn after_the_window_a_new_code_is_issued_and_the_old_one_still_verifies() {
        let pool = test_pool().await;
        let (user, email) = unverified_user(&pool).await;

        issue(&pool, user, &email).await;
        age_codes(&pool, user, 61).await;
        issue(&pool, user, &email).await;

        let rows = codes(&pool, user).await;
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(!rows[0].1 && !rows[1].1, "both live: {rows:?}");

        // The user opened the first email, not the newest.
        assert_eq!(verify(&pool, &email, &rows[0].0).await, StatusCode::OK);
        assert!(is_verified(&pool, user).await);
        assert!(
            codes(&pool, user).await.iter().all(|(_, used)| *used),
            "every code is retired once verified"
        );

        cleanup(&pool, user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn an_expired_code_no_longer_verifies() {
        let pool = test_pool().await;
        let (user, email) = unverified_user(&pool).await;

        issue(&pool, user, &email).await;
        sqlx::query(
            "UPDATE email_verification_tokens SET expires_at = NOW() - INTERVAL '1 second' \
             WHERE user_id = $1",
        )
        .bind(user)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("expire: {e}"));
        let code = codes(&pool, user).await[0].0.clone();

        assert_eq!(verify(&pool, &email, &code).await, StatusCode::BAD_REQUEST);
        assert!(!is_verified(&pool, user).await);

        cleanup(&pool, user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn wrong_guesses_are_shared_across_live_codes() {
        let pool = test_pool().await;
        let (user, email) = unverified_user(&pool).await;

        issue(&pool, user, &email).await;
        for _ in 0..2 {
            assert_eq!(
                verify(&pool, &email, "not-a-code").await,
                StatusCode::BAD_REQUEST
            );
        }
        // A new code after the window starts from the shared count, not zero.
        age_codes(&pool, user, 61).await;
        issue(&pool, user, &email).await;
        for _ in 2..MAX_VERIFY_ATTEMPTS {
            assert_eq!(
                verify(&pool, &email, "not-a-code").await,
                StatusCode::BAD_REQUEST
            );
        }

        let newest = codes(&pool, user).await.last().map(|(t, _)| t.clone());
        let newest = newest.unwrap_or_else(|| panic!("no code"));
        assert_eq!(
            verify(&pool, &email, &newest).await,
            StatusCode::TOO_MANY_REQUESTS,
            "out of guesses, even with the right code"
        );
        assert!(!is_verified(&pool, user).await);
        assert!(codes(&pool, user).await.iter().all(|(_, used)| *used));

        cleanup(&pool, user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_code_out_of_guesses_is_replaced_not_resent() {
        let pool = test_pool().await;
        let (user, email) = unverified_user(&pool).await;

        issue(&pool, user, &email).await;
        sqlx::query("UPDATE email_verification_tokens SET attempts = $2 WHERE user_id = $1")
            .bind(user)
            .bind(MAX_VERIFY_ATTEMPTS)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("burn: {e}"));
        issue(&pool, user, &email).await;

        let rows = codes(&pool, user).await;
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows[0].1 && !rows[1].1, "{rows:?}");

        cleanup(&pool, user).await;
    }
}
