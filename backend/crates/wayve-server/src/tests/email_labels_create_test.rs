// Creating a Gmail label (email/labels.rs create_label): the Gmail call (mocked),
// storing it so the sidebar lists it at once, and the endpoint's checks — your
// own Gmail mailbox only, a real name, and a usable connection.
#[cfg(test)]
mod tests {
    use crate::email::labels::{
        CreatedLabel, GmailLabel, create_gmail_label, create_label, sidebar_labels, store_one,
    };
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn mailbox(pool: &PgPool, provider: &str) -> (i32, String, i32) {
        let login = random_email();
        let user = insert_local_user(pool, &login, "password123").await;
        let account: i32 = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .bind(provider)
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
    async fn creates_at_gmail_and_reports_a_duplicate() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/labels"))
            .and(body_partial_json(serde_json::json!({
                "name": "clients/acme",
                "labelListVisibility": "labelShow",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "Label_42", "name": "clients/acme", "type": "user",
            })))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/labels"))
            .and(body_partial_json(serde_json::json!({ "name": "taken" })))
            .respond_with(ResponseTemplate::new(409))
            .mount(&mock)
            .await;
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };
        let created = create_gmail_label("tok", "clients/acme").await;
        let taken = create_gmail_label("tok", "taken").await;
        let refused = create_gmail_label("tok", "anything-else").await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };

        assert_eq!(
            created.unwrap_or_else(|e| panic!("create: {e}")),
            CreatedLabel::Created(GmailLabel {
                id: "Label_42".into(),
                name: "clients/acme".into(),
                color: None,
            })
        );
        assert_eq!(
            taken.unwrap_or_else(|e| panic!("taken: {e}")),
            CreatedLabel::Exists
        );
        // No matching mock: wiremock answers 404, which is an error, not "created".
        assert!(refused.is_err());
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_stored_label_shows_in_the_sidebar_at_once() {
        let pool = test_pool().await;
        let (user, _, account) = mailbox(&pool, "google").await;
        let label = GmailLabel {
            id: "Label_7".into(),
            name: "receipts".into(),
            color: Some("#16a766".into()),
        };
        store_one(&pool, account, &label)
            .await
            .unwrap_or_else(|e| panic!("store: {e}"));
        let labels = sidebar_labels(&pool, user, Some(account))
            .await
            .unwrap_or_else(|e| panic!("sidebar: {e}"));
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].label_id, "Label_7");
        assert_eq!(labels[0].name, "receipts");
        assert_eq!(labels[0].color.as_deref(), Some("#16a766"));
        cleanup(&pool, &[user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn only_your_own_connected_gmail_mailbox_and_a_real_name() {
        let pool = test_pool().await;
        let (me, login, gmail) = mailbox(&pool, "google").await;
        let (other, _, theirs) = mailbox(&pool, "google").await;
        let (imap_user, imap_login, imap) = mailbox(&pool, "imap").await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_label),
        )
        .await;
        let post = |user: i32, login: &str, account: i32, name: &str| {
            actix_test::TestRequest::post()
                .uri("/emails/labels")
                .insert_header(("Authorization", format!("Bearer {}", jwt_for(user, login))))
                .set_json(serde_json::json!({ "account_id": account, "name": name }))
                .to_request()
        };

        // Someone else's mailbox reads as not found.
        let resp = actix_test::call_service(&app, post(me, &login, theirs, "x")).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        // A blank or overlong name is refused before anything reaches Gmail.
        let resp = actix_test::call_service(&app, post(me, &login, gmail, "   ")).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let long = "x".repeat(226);
        let resp = actix_test::call_service(&app, post(me, &login, gmail, &long)).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        // Labels are a Gmail thing.
        let resp = actix_test::call_service(&app, post(imap_user, &imap_login, imap, "x")).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        // A Gmail mailbox with no refresh token has to be reconnected first.
        let resp = actix_test::call_service(&app, post(me, &login, gmail, "receipts")).await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        // No session at all.
        let req = actix_test::TestRequest::post()
            .uri("/emails/labels")
            .set_json(serde_json::json!({ "account_id": gmail, "name": "x" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::UNAUTHORIZED
        );

        cleanup(&pool, &[me, other, imap_user]).await;
    }
}
