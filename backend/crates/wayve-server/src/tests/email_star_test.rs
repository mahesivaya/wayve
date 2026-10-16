// Stars, as in Gmail (routes/email.rs set_star): the STARRED label here and at
// the provider (Gmail's label, Outlook's flag, both mocked here). A
// conversation row is starred while any message is, the Starred folder lists
// it, and an IMAP re-sync keeps a Fluxze-only star.
#[cfg(test)]
mod tests {
    use crate::email::provider::{
        GoogleMailClient, GoogleOAuthClient, MailStar, OutlookMailClient,
    };
    use crate::email::repo::{self, EmailListFilters, EmailListRow, InsertEmail};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use chrono::Utc;
    use sqlx::PgPool;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

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

    async fn user(pool: &PgPool) -> (i32, String) {
        let login = random_email();
        (insert_local_user(pool, &login, "password123").await, login)
    }

    async fn labels(pool: &PgPool, id: i32) -> Vec<String> {
        sqlx::query_scalar("SELECT labels FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("labels: {e}"))
    }

    async fn list(pool: &PgPool, user: i32, folder: &str, grouped: bool) -> Vec<EmailListRow> {
        repo::list(
            pool,
            EmailListFilters {
                user_id: user,
                account_id: None,
                folder: Some(folder.to_string()),
                inbox_status: None,
                search: None,
                before: None,
                page_size: 200,
                group_threads: grouped,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("list {folder}: {e}"))
    }

    async fn call(pool: &PgPool, user: i32, login: &str, id: i32, action: &str) -> StatusCode {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::star_email)
                .service(crate::routes::email::unstar_email),
        )
        .await;
        let req = actix_test::TestRequest::post()
            .uri(&format!("/emails/{id}/{action}"))
            .insert_header(("Authorization", format!("Bearer {}", jwt_for(user, login))))
            .to_request();
        actix_test::call_service(&app, req).await.status()
    }

    /// IMAP message 7 as each sync tick reports it, with the server's labels.
    fn row(labels: &[String]) -> InsertEmail<'_> {
        InsertEmail {
            gmail_id: "imap-7",
            sender: "ada@x.com",
            receiver: "me@x.com",
            cc: None,
            subject: "Plans",
            created_at: Utc::now().naive_utc(),
            is_read: false,
            labels,
            body: None,
            attachments_checked: true,
        }
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
    async fn fluxze_mail_stars_and_unstars_and_no_one_else_can_star_it() {
        let pool = test_pool().await;
        let (me, login) = user(&pool).await;
        let (stranger, stranger_login) = user(&pool).await;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, subject, sender, receiver, body_encrypted, \
                                 body_iv, labels, source, recipient_user_id) \
             VALUES ($1, NULL, 'Hi', 'a@x.com', 'b@x.com', 'ct', 'iv', \
                     ARRAY['INBOX']::text[], 'wayve', $2) RETURNING id",
        )
        .bind(format!("wayve:test:{}", random_email()))
        .bind(me)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));

        assert_eq!(
            call(&pool, stranger, &stranger_login, id, "star").await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(labels(&pool, id).await, ["INBOX"]);

        assert_eq!(call(&pool, me, &login, id, "star").await, StatusCode::OK);
        assert_eq!(labels(&pool, id).await, ["INBOX", "STARRED"]);
        // Starring again is harmless.
        assert_eq!(call(&pool, me, &login, id, "star").await, StatusCode::OK);
        assert_eq!(labels(&pool, id).await, ["INBOX", "STARRED"]);
        let starred = list(&pool, me, "starred", false).await;
        assert!(starred.iter().any(|row| row.id == id && row.is_starred));
        // Still in the inbox too: a star is a label, not a folder move.
        let inbox = list(&pool, me, "inbox", false).await;
        assert!(inbox.iter().any(|row| row.id == id && row.is_starred));

        assert_eq!(call(&pool, me, &login, id, "unstar").await, StatusCode::OK);
        assert_eq!(labels(&pool, id).await, ["INBOX"]);
        assert!(
            !list(&pool, me, "starred", false)
                .await
                .iter()
                .any(|row| row.id == id)
        );

        let _ = sqlx::query("DELETE FROM emails WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await;
        cleanup(&pool, &[me, stranger]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_conversation_is_starred_while_any_message_is() {
        let pool = test_pool().await;
        let (me, _) = user(&pool).await;
        let account: i32 = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(me)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        let thread: i32 =
            sqlx::query_scalar("INSERT INTO email_threads (account_id) VALUES ($1) RETURNING id")
                .bind(account)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("thread: {e}"));
        let email = |labels: &'static [&'static str], minutes: i64| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i32>(
                    "INSERT INTO emails (gmail_id, account_id, thread_id, sender, labels, created_at) \
                     VALUES ($1, $2, $3, 'ada@x.com', $4, now() - make_interval(mins => $5::int)) \
                     RETURNING id",
                )
                .bind(format!("g-{}", random_email()))
                .bind(account)
                .bind(thread)
                .bind(labels.iter().map(|l| l.to_string()).collect::<Vec<_>>())
                .bind(minutes)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("email: {e}"))
            }
        };
        // The older message is starred, the newest (the row) is not.
        let older = email(&["INBOX", "STARRED"], 30).await;
        let newest = email(&["INBOX"], 5).await;

        for folder in ["inbox", "starred"] {
            let rows = list(&pool, me, folder, true).await;
            let row = rows
                .iter()
                .find(|row| row.thread_id == Some(thread))
                .unwrap_or_else(|| panic!("conversation not listed in {folder}"));
            assert_eq!(row.id, newest);
            assert!(row.is_starred, "starred in {folder}");
            assert_eq!(row.starred_ids, Some(vec![older]));
        }

        cleanup(&pool, &[me]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn an_imap_resync_keeps_a_fluxze_star_and_trash() {
        ensure_aes_key();
        let pool = test_pool().await;
        let (me, login) = user(&pool).await;
        let account: i32 = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'imap') RETURNING id",
        )
        .bind(random_email())
        .bind(me)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        let id = repo::upsert_one(&pool, account, &row(&[]))
            .await
            .unwrap_or_else(|e| panic!("upsert: {e}"));

        assert_eq!(call(&pool, me, &login, id, "star").await, StatusCode::OK);
        repo::upsert_one(&pool, account, &row(&[]))
            .await
            .unwrap_or_else(|e| panic!("resync: {e}"));
        assert_eq!(
            labels(&pool, id).await,
            ["STARRED"],
            "a resync keeps the star"
        );

        // With a trash label too, and the server's own labels still applied.
        sqlx::query("UPDATE emails SET labels = labels || 'TRASH'::text WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("trash: {e}"));
        let spam = ["SPAM".to_string()];
        repo::upsert_one(&pool, account, &row(&spam))
            .await
            .unwrap_or_else(|e| panic!("resync: {e}"));
        assert_eq!(labels(&pool, id).await, ["SPAM", "STARRED", "TRASH"]);

        assert_eq!(call(&pool, me, &login, id, "unstar").await, StatusCode::OK);
        repo::upsert_one(&pool, account, &row(&[]))
            .await
            .unwrap_or_else(|e| panic!("resync: {e}"));
        assert_eq!(labels(&pool, id).await, ["TRASH"], "and stays unstarred");

        cleanup(&pool, &[me]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn gmail_stars_with_the_starred_label() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/m1/modify"))
            .and(body_json(serde_json::json!({ "addLabelIds": ["STARRED"] })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "m1" })),
            )
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/m1/modify"))
            .and(body_json(
                serde_json::json!({ "removeLabelIds": ["STARRED"] }),
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "m1" })),
            )
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/gone/modify"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };

        let gmail = GoogleMailClient {
            oauth: GoogleOAuthClient {
                client_id: "x".into(),
                client_secret: "y".into(),
            },
        };
        let star = gmail.set_starred("tok", "m1", true).await;
        let unstar = gmail.set_starred("tok", "m1", false).await;
        let gone = gmail.set_starred("tok", "gone", true).await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };

        star.unwrap_or_else(|e| panic!("star: {e}"));
        unstar.unwrap_or_else(|e| panic!("unstar: {e}"));
        assert!(gone.is_err(), "a failed star must reach the user");
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn outlook_stars_with_the_follow_up_flag() {
        let mock = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/v1.0/me/messages/m1"))
            .and(body_json(
                serde_json::json!({ "flag": { "flagStatus": "flagged" } }),
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "m1" })),
            )
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/v1.0/me/messages/m1"))
            .and(body_json(
                serde_json::json!({ "flag": { "flagStatus": "notFlagged" } }),
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "m1" })),
            )
            .expect(1)
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("MICROSOFT_GRAPH_BASE", mock.uri()) };

        let outlook = OutlookMailClient {
            creds: crate::email::outlook::OutlookCredentials {
                client_id: "x".into(),
                client_secret: "y".into(),
                redirect_uri: "https://example.com/cb".into(),
            },
        };
        let star = outlook.set_starred("tok", "m1", true).await;
        let unstar = outlook.set_starred("tok", "m1", false).await;
        unsafe { std::env::remove_var("MICROSOFT_GRAPH_BASE") };

        star.unwrap_or_else(|e| panic!("star: {e}"));
        unstar.unwrap_or_else(|e| panic!("unstar: {e}"));
    }
}
