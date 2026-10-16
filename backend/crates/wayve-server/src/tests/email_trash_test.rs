// Delete moves an email to Trash and Restore brings it back (routes/email.rs
// move_email). The row is kept with a TRASH label, which only the Trash folder
// lists. Gmail and Outlook move the provider copy too (mocked here); Fluxze and
// IMAP mail is trashed in Fluxze only, and an IMAP re-sync keeps the label.
#[cfg(test)]
mod tests {
    use crate::email::provider::{
        GoogleMailClient, GoogleOAuthClient, MailTrash, OutlookMailClient, TrashMoved,
    };
    use crate::email::repo::{self, EmailListFilters, InsertEmail};
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

    async fn mailbox(pool: &PgPool, user: i32, provider: &str) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .bind(provider)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"))
    }

    async fn labels(pool: &PgPool, id: i32) -> Vec<String> {
        sqlx::query_scalar("SELECT labels FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("labels: {e}"))
    }

    async fn listed(pool: &PgPool, user: i32, folder: &str, id: i32) -> bool {
        let rows = repo::list(
            pool,
            EmailListFilters {
                user_id: user,
                account_id: None,
                folder: Some(folder.to_string()),
                inbox_status: None,
                search: None,
                before: None,
                page_size: 200,
                group_threads: false,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("list {folder}: {e}"));
        rows.iter().any(|row| row.id == id)
    }

    async fn call(pool: &PgPool, user: i32, login: &str, id: i32, restore: bool) -> StatusCode {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::delete_email)
                .service(crate::routes::email::restore_email),
        )
        .await;
        let req = if restore {
            actix_test::TestRequest::post().uri(&format!("/emails/{id}/restore"))
        } else {
            actix_test::TestRequest::delete().uri(&format!("/emails/{id}"))
        }
        .insert_header(("Authorization", format!("Bearer {}", jwt_for(user, login))))
        .to_request();
        actix_test::call_service(&app, req).await.status()
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
    async fn fluxze_mail_moves_to_trash_and_back_and_no_one_else_can_move_it() {
        let pool = test_pool().await;
        let (recipient, login) = user(&pool).await;
        let (stranger, stranger_login) = user(&pool).await;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, subject, sender, receiver, body_encrypted, \
                                 body_iv, labels, source, recipient_user_id) \
             VALUES ($1, NULL, 'Hi', 'a@x.com', 'b@x.com', 'ct', 'iv', \
                     ARRAY['INBOX']::text[], 'wayve', $2) RETURNING id",
        )
        .bind(format!("wayve:test:{}", random_email()))
        .bind(recipient)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));
        assert!(listed(&pool, recipient, "inbox", id).await);

        assert_eq!(
            call(&pool, stranger, &stranger_login, id, false).await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(labels(&pool, id).await, ["INBOX"]);

        // Delete keeps the row: out of the inbox, into Trash.
        assert_eq!(
            call(&pool, recipient, &login, id, false).await,
            StatusCode::OK
        );
        assert_eq!(labels(&pool, id).await, ["INBOX", "TRASH"]);
        assert!(!listed(&pool, recipient, "inbox", id).await);
        assert!(listed(&pool, recipient, "trash", id).await);
        // Deleting again is harmless.
        assert_eq!(
            call(&pool, recipient, &login, id, false).await,
            StatusCode::OK
        );
        assert_eq!(labels(&pool, id).await, ["INBOX", "TRASH"]);

        assert_eq!(
            call(&pool, recipient, &login, id, true).await,
            StatusCode::OK
        );
        assert_eq!(labels(&pool, id).await, ["INBOX"]);
        assert!(listed(&pool, recipient, "inbox", id).await);
        assert!(!listed(&pool, recipient, "trash", id).await);

        let audited: Vec<String> = sqlx::query_scalar(
            "SELECT action FROM audit_logs WHERE resource_id = $1 AND actor_user_id = $2 \
             ORDER BY id",
        )
        .bind(id.to_string())
        .bind(recipient)
        .fetch_all(&pool)
        .await
        .unwrap_or_else(|e| panic!("audit: {e}"));
        assert_eq!(
            audited,
            ["email_deleted", "email_deleted", "email_restored"]
        );

        let _ = sqlx::query("DELETE FROM emails WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await;
        cleanup(&pool, &[recipient, stranger]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn imap_mail_is_trashed_in_fluxze_and_a_resync_keeps_it_there() {
        ensure_aes_key();
        let pool = test_pool().await;
        let (me, login) = user(&pool).await;
        let account = mailbox(&pool, me, "imap").await;
        let row = InsertEmail {
            gmail_id: "imap-42",
            sender: "ada@x.com",
            receiver: "me@x.com",
            cc: None,
            subject: "Plans",
            created_at: Utc::now().naive_utc(),
            is_read: false,
            labels: &[],
            body: None,
            attachments_checked: true,
        };
        let id = repo::upsert_one(&pool, account, &row)
            .await
            .unwrap_or_else(|e| panic!("upsert: {e}"));

        // No refresh token and no provider call: IMAP used to be sent to Gmail's
        // API here and fail.
        assert_eq!(call(&pool, me, &login, id, false).await, StatusCode::OK);
        assert_eq!(labels(&pool, id).await, ["TRASH"]);

        // The server copy is still in INBOX, so sync reports no labels.
        repo::upsert_one(&pool, account, &row)
            .await
            .unwrap_or_else(|e| panic!("resync: {e}"));
        assert_eq!(
            labels(&pool, id).await,
            ["TRASH"],
            "a resync keeps it in Trash"
        );
        assert!(listed(&pool, me, "trash", id).await);
        assert!(!listed(&pool, me, "inbox", id).await);

        assert_eq!(call(&pool, me, &login, id, true).await, StatusCode::OK);
        assert!(labels(&pool, id).await.is_empty());
        repo::upsert_one(&pool, account, &row)
            .await
            .unwrap_or_else(|e| panic!("resync after restore: {e}"));
        assert!(labels(&pool, id).await.is_empty(), "and stays restored");
        assert!(listed(&pool, me, "inbox", id).await);

        cleanup(&pool, &[me]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_trashed_email_is_listed_only_in_trash() {
        let pool = test_pool().await;
        let (me, _) = user(&pool).await;
        let account = mailbox(&pool, me, "google").await;
        // As Gmail reports trashed mail: its other labels stay on.
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, labels) \
             VALUES ($1, $2, 'ada@x.com', ARRAY['TRASH', 'IMPORTANT', 'CATEGORY_UPDATES']::text[]) \
             RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));

        assert!(listed(&pool, me, "trash", id).await);
        for folder in ["inbox", "important", "updates", "all", "sent"] {
            assert!(!listed(&pool, me, folder, id).await, "listed in {folder}");
        }

        cleanup(&pool, &[me]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_move_stores_the_new_provider_id_and_a_restore_to_the_inbox_relabels_it() {
        let pool = test_pool().await;
        let (me, _) = user(&pool).await;
        let account = mailbox(&pool, me, "microsoft").await;
        // Sync mirrored Gmail dropping INBOX from trashed mail.
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, labels) \
             VALUES ('old-id', $1, 'ada@x.com', ARRAY['TRASH']::text[]) RETURNING id",
        )
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));

        let moved = TrashMoved {
            new_id: Some("new-id".into()),
            in_inbox: true,
        };
        repo::set_trashed(&pool, id, false, &moved)
            .await
            .unwrap_or_else(|e| panic!("restore: {e}"));
        assert_eq!(labels(&pool, id).await, ["INBOX"]);
        let gmail_id: String = sqlx::query_scalar("SELECT gmail_id FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("gmail_id: {e}"));
        assert_eq!(gmail_id, "new-id");

        cleanup(&pool, &[me]).await;
    }

    fn gmail() -> GoogleMailClient {
        GoogleMailClient {
            oauth: GoogleOAuthClient {
                client_id: "x".into(),
                client_secret: "y".into(),
            },
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn gmail_trashes_and_untrashes_and_reports_the_inbox() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/m1/trash"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "m1", "labelIds": ["TRASH"] })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/m1/untrash"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({ "id": "m1", "labelIds": ["INBOX", "UNREAD"] }),
                ),
            )
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/gone/trash"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/gmail/v1/users/me/messages/gone/untrash"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };

        let trashed = gmail().trash("tok", "m1").await;
        let restored = gmail().restore("tok", "m1").await;
        let trash_gone = gmail().trash("tok", "gone").await;
        let restore_gone = gmail().restore("tok", "gone").await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };

        assert_eq!(
            trashed.unwrap_or_else(|e| panic!("trash: {e}")),
            TrashMoved::default()
        );
        assert_eq!(
            restored.unwrap_or_else(|e| panic!("restore: {e}")),
            TrashMoved {
                new_id: None,
                in_inbox: true
            }
        );
        // Trashing mail Gmail no longer has is done; restoring it can't be.
        assert_eq!(
            trash_gone.unwrap_or_else(|e| panic!("trash gone: {e}")),
            TrashMoved::default()
        );
        assert!(restore_gone.is_err());
    }

    fn outlook() -> OutlookMailClient {
        OutlookMailClient {
            creds: crate::email::outlook::OutlookCredentials {
                client_id: "x".into(),
                client_secret: "y".into(),
                redirect_uri: "https://example.com/cb".into(),
            },
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn outlook_moves_to_deleted_items_and_back_returning_the_new_id() {
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1.0/me/messages/m1/move"))
            .and(body_json(
                serde_json::json!({ "destinationId": "deleteditems" }),
            ))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "m1-trashed" })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1.0/me/messages/m1-trashed/move"))
            .and(body_json(serde_json::json!({ "destinationId": "inbox" })))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "m1-back" })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1.0/me/messages/gone/move"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("MICROSOFT_GRAPH_BASE", mock.uri()) };

        let trashed = outlook().trash("tok", "m1").await;
        let restored = outlook().restore("tok", "m1-trashed").await;
        let trash_gone = outlook().trash("tok", "gone").await;
        let restore_gone = outlook().restore("tok", "gone").await;
        unsafe { std::env::remove_var("MICROSOFT_GRAPH_BASE") };

        assert_eq!(
            trashed.unwrap_or_else(|e| panic!("trash: {e}")),
            TrashMoved {
                new_id: Some("m1-trashed".into()),
                in_inbox: false
            }
        );
        assert_eq!(
            restored.unwrap_or_else(|e| panic!("restore: {e}")),
            TrashMoved {
                new_id: Some("m1-back".into()),
                in_inbox: true
            }
        );
        assert_eq!(
            trash_gone.unwrap_or_else(|e| panic!("trash gone: {e}")),
            TrashMoved::default()
        );
        assert!(restore_gone.is_err());
    }
}
