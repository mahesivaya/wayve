// The email sidebar (email/labels.rs + repo::sidebar_counts): folder badges
// count what each folder lists, the Labels tree shows only the caller's own
// mailboxes' labels with unread counts that skip trash, and a label folder
// lists exactly that account's labelled mail.
#[cfg(test)]
mod tests {
    use crate::email::labels::{GmailLabel, get_sidebar, store};
    use crate::email::repo::{self, EmailListFilters};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use serde_json::Value;
    use sqlx::PgPool;

    async fn mailbox(pool: &PgPool, user: i32) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"))
    }

    async fn email(pool: &PgPool, account: i32, labels: &[&str], read: bool) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, is_read) \
             VALUES ($1, $2, 'ada@x.com', $3, $4) RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(account)
        .bind(labels.iter().map(|l| l.to_string()).collect::<Vec<_>>())
        .bind(read)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"))
    }

    fn label(id: &str, name: &str) -> GmailLabel {
        GmailLabel {
            id: id.into(),
            name: name.into(),
            color: None,
        }
    }

    #[actix_web::test]
    async fn sidebar_counts_labels_and_label_folder() {
        let pool = test_pool().await;
        let me = insert_local_user(&pool, &random_email(), "pw").await;
        let other = insert_local_user(&pool, &random_email(), "pw").await;
        let mine = mailbox(&pool, me).await;
        let theirs = mailbox(&pool, other).await;

        store(&pool, mine, &[label("Label_1", "Work/Clients")])
            .await
            .unwrap_or_else(|e| panic!("store: {e}"));
        // Same Gmail id in someone else's mailbox: must not leak in.
        store(&pool, theirs, &[label("Label_1", "Private")])
            .await
            .unwrap_or_else(|e| panic!("store: {e}"));

        email(&pool, mine, &["INBOX"], false).await;
        email(&pool, mine, &["INBOX"], true).await;
        let labelled = email(&pool, mine, &["Label_1"], false).await;
        email(&pool, mine, &["Label_1", "TRASH"], false).await;
        email(&pool, mine, &["DRAFT"], true).await;
        email(&pool, mine, &["SPAM"], false).await;
        email(&pool, theirs, &["INBOX", "Label_1"], false).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_sidebar),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/emails/sidebar")
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::UNAUTHORIZED
        );

        let req = actix_test::TestRequest::get()
            .uri("/emails/sidebar")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(me, "ignored@example.com")),
            ))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: Value = actix_test::read_body_json(resp).await;

        assert_eq!(body["counts"]["inbox"], 1, "unread inbox mail");
        assert_eq!(body["counts"]["drafts"], 1, "drafts count every draft");
        assert_eq!(body["counts"]["spam"], 1);
        let labels = body["labels"].as_array().cloned().unwrap_or_default();
        assert_eq!(labels.len(), 1, "only my mailbox's labels: {labels:?}");
        assert_eq!(labels[0]["account_id"], mine);
        assert_eq!(labels[0]["label_id"], "Label_1");
        assert_eq!(labels[0]["name"], "Work/Clients");
        assert_eq!(labels[0]["unread"], 1, "trashed mail is not counted");

        // Opening the label lists that one email.
        let rows = repo::list(
            &pool,
            EmailListFilters {
                user_id: me,
                account_id: None,
                folder: Some(format!("label:{mine}:Label_1")),
                inbox_status: None,
                search: None,
                before: None,
                page_size: 50,
                group_threads: false,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("list: {e}"));
        assert_eq!(
            rows.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![labelled]
        );

        // Pointing a label folder at someone else's mailbox lists nothing.
        let rows = repo::list(
            &pool,
            EmailListFilters {
                user_id: me,
                account_id: None,
                folder: Some(format!("label:{theirs}:Label_1")),
                inbox_status: None,
                search: None,
                before: None,
                page_size: 50,
                group_threads: false,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("list: {e}"));
        assert!(rows.is_empty());

        // A relabel replaces the stored set.
        store(&pool, mine, &[label("Label_9", "Receipts")])
            .await
            .unwrap_or_else(|e| panic!("store: {e}"));
        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM mailbox_labels WHERE account_id = $1")
                .bind(mine)
                .fetch_all(&pool)
                .await
                .unwrap_or_else(|e| panic!("names: {e}"));
        assert_eq!(names, vec!["Receipts".to_string()]);

        for id in [me, other] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(&pool)
                .await;
        }
    }
}
