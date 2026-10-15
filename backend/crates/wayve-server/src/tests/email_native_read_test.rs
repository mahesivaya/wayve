// A Fluxze-to-Fluxze email belongs to its recipient, not to a connected
// mailbox. Marking it read or unread used to 404 (the handlers only knew
// mailbox-owned mail), so it showed unread again on every refresh.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    async fn user(pool: &PgPool) -> (i32, String) {
        let email = random_email();
        (insert_local_user(pool, &email, "password123").await, email)
    }

    // The recipient's copy of a Fluxze-to-Fluxze email, as send_internal stores it.
    async fn native_email(pool: &PgPool, recipient: i32) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, subject, sender, receiver, body_encrypted, \
                                 body_iv, is_read, labels, source, recipient_user_id) \
             VALUES ($1, NULL, 'Test2', 'a@x.com', 'b@x.com', 'ct', 'iv', FALSE, \
                     ARRAY['INBOX']::text[], 'wayve', $2) RETURNING id",
        )
        .bind(format!("wayve:test:{}", random_email()))
        .bind(recipient)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"))
    }

    async fn is_read(pool: &PgPool, id: i32) -> bool {
        sqlx::query_scalar("SELECT is_read FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("is_read: {e}"))
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn the_recipient_can_mark_fluxze_mail_read_and_unread_and_no_one_else() {
        let pool = test_pool().await;
        let (recipient, recipient_email) = user(&pool).await;
        let (sender, sender_email) = user(&pool).await;
        let id = native_email(&pool, recipient).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::mark_email_read)
                .service(crate::routes::email::mark_email_unread),
        )
        .await;
        let call = |action: &str, user: i32, email: &str| {
            actix_test::TestRequest::post()
                .uri(&format!("/emails/{id}/{action}"))
                .insert_header(("Authorization", format!("Bearer {}", jwt_for(user, email))))
                .to_request()
        };

        // Someone else — the sender included — can't touch the recipient's copy.
        let resp = actix_test::call_service(&app, call("read", sender, &sender_email)).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(!is_read(&pool, id).await);

        let resp = actix_test::call_service(&app, call("read", recipient, &recipient_email)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(is_read(&pool, id).await, "opening it marks it read");
        // Marking it again is harmless.
        let resp = actix_test::call_service(&app, call("read", recipient, &recipient_email)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(is_read(&pool, id).await);

        let resp =
            actix_test::call_service(&app, call("unread", recipient, &recipient_email)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(!is_read(&pool, id).await, "and unread again");
        let resp = actix_test::call_service(&app, call("unread", sender, &sender_email)).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // Each change is audited, like mailbox mail.
        let audited: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_logs WHERE resource_id = $1 \
             AND action IN ('email_read', 'email_unread') AND actor_user_id = $2",
        )
        .bind(id.to_string())
        .bind(recipient)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("audit: {e}"));
        assert_eq!(audited, 2);

        for u in [recipient, sender] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(u)
                .execute(&pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM emails WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await;
    }
}
