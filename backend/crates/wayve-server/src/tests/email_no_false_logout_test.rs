// The client treats every 401 as an expired session and logs the user out, so a
// mailbox problem must never answer 401 while the session itself is valid.
// Deleting from a mailbox with no refresh token used to, and so did sending from
// a mailbox the user can't send from, which signed users out of Fluxze.
#[cfg(test)]
mod tests {
    use crate::models::email_request::SendEmailRequest;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    /// A user with a Gmail mailbox that has no refresh token.
    async fn mailbox(pool: &PgPool) -> (i32, String, i32) {
        let login = random_email();
        let user = insert_local_user(pool, &login, "password123").await;
        let account: i32 = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        (user, login, account)
    }

    async fn cleanup(pool: &PgPool, users: &[i32]) {
        for id in users {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn deleting_from_a_mailbox_without_a_refresh_token_is_a_conflict_not_a_logout() {
        let pool = test_pool().await;
        let (user, login, account) = mailbox(&pool).await;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, subject, sender, receiver, \
                                 body_encrypted, body_iv, source) \
             VALUES ($1, $2, 'Hi', 'a@x.com', 'b@x.com', 'ct', 'iv', 'gmail') RETURNING id",
        )
        .bind(format!("gmail-{}", random_email()))
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::delete_email),
        )
        .await;
        let req = actix_test::TestRequest::delete()
            .uri(&format!("/emails/{id}"))
            .insert_header(("Authorization", format!("Bearer {}", jwt_for(user, &login))))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert_eq!(
            body["error"],
            "Reconnect your email account to delete this email"
        );

        // Nothing was deleted: the provider copy was never touched.
        let still_there: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM emails WHERE id = $1)")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("exists: {e}"));
        assert!(still_there);

        cleanup(&pool, &[user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn sending_from_a_mailbox_you_cant_send_from_is_not_found_not_a_logout() {
        let pool = test_pool().await;
        let (me, my_login, _) = mailbox(&pool).await;
        // Someone else's mailbox, which `me` has no access to.
        let (owner, _, theirs) = mailbox(&pool).await;

        let req = actix_test::TestRequest::post()
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(me, &my_login)),
            ))
            .to_http_request();
        let data = SendEmailRequest {
            account_id: theirs,
            to: "bob@example.com".into(),
            subject: "Hi".into(),
            body: "hello".into(),
            cc: vec![],
            bcc: vec![],
            attachments: vec![],
            forward_attachment_ids: vec![],
            reply_to_email_id: None,
            reply_headers: None,
        };
        let resp = crate::email::send::send(req, web::Json(data), web::Data::new(pool.clone()))
            .await
            .unwrap_or_else(|e| panic!("send: {e:?}"));
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        cleanup(&pool, &[me, owner]).await;
    }
}
