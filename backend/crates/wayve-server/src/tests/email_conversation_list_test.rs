// The conversation (Gmail-style) email list. A grouped folder lists one row per
// conversation, positioned by its newest message — your own sent reply
// included — and the conversation endpoint returns every message, oldest
// first, to its owner only. The per-email list is unchanged.
#[cfg(test)]
mod tests {
    use crate::email::repo::{self, EmailListFilters, EmailListRow};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use chrono::NaiveDateTime;
    use sqlx::PgPool;

    struct Mailbox {
        user: i32,
        user_email: String,
        account: i32,
        address: String,
    }

    async fn mailbox(pool: &PgPool) -> Mailbox {
        let user_email = random_email();
        let user = insert_local_user(pool, &user_email, "password123").await;
        let address = random_email();
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(&address)
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        Mailbox {
            user,
            user_email,
            account,
            address,
        }
    }

    async fn thread(pool: &PgPool, account: i32) -> i32 {
        sqlx::query_scalar("INSERT INTO email_threads (account_id) VALUES ($1) RETURNING id")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("thread: {e}"))
    }

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M")
            .unwrap_or_else(|e| panic!("date {s}: {e}"))
    }

    // A fixture row needs all six; a struct would only rename them.
    #[allow(clippy::too_many_arguments)]
    async fn email(
        pool: &PgPool,
        account: i32,
        thread_id: Option<i32>,
        sender: &str,
        labels: &[&str],
        when: &str,
    ) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, thread_id, sender, labels, is_read, created_at) \
             VALUES ($1, $2, $3, $4, $5, TRUE, $6) RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(account)
        .bind(thread_id)
        .bind(sender)
        .bind(labels.iter().map(|l| l.to_string()).collect::<Vec<_>>())
        .bind(at(when))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"))
    }

    fn filters(user: i32, account: i32, folder: &str, grouped: bool) -> EmailListFilters {
        EmailListFilters {
            user_id: user,
            account_id: Some(account),
            folder: Some(folder.to_string()),
            inbox_status: None,
            search: None,
            before: None,
            page_size: 50,
            group_threads: grouped,
        }
    }

    async fn list(pool: &PgPool, f: EmailListFilters) -> Vec<EmailListRow> {
        repo::list(pool, f)
            .await
            .unwrap_or_else(|e| panic!("list: {e}"))
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
    async fn inbox_groups_a_conversation_under_its_newest_message_your_reply_included() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let t = thread(&pool, me.account).await;
        let invite = email(
            &pool,
            me.account,
            Some(t),
            "Alice <alice@x.com>",
            &["INBOX"],
            "2026-07-19 10:00",
        )
        .await;
        let reply = email(
            &pool,
            me.account,
            Some(t),
            &me.address,
            &["SENT"],
            "2026-10-07 09:00",
        )
        .await;
        // Trashed messages never surface as a conversation's newest.
        email(
            &pool,
            me.account,
            Some(t),
            "Alice <alice@x.com>",
            &["TRASH"],
            "2026-10-08 09:00",
        )
        .await;
        let other = email(
            &pool,
            me.account,
            None,
            "Bob <bob@x.com>",
            &["INBOX"],
            "2026-09-01 09:00",
        )
        .await;

        let rows = list(&pool, filters(me.user, me.account, "inbox", true)).await;
        let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
        assert_eq!(
            ids,
            vec![reply, other],
            "one row per conversation, newest first"
        );
        assert_eq!(rows[0].message_count, Some(2));
        assert_eq!(rows[0].thread_id, Some(t));
        assert_eq!(rows[0].message_ids.as_deref(), Some(&[reply, invite][..]));
        // An email with no conversation yet is its own row.
        assert_eq!(rows[1].message_count, Some(1));
        assert_eq!(rows[1].thread_id, None);

        // The per-email list is unchanged: the reply stays out of the Inbox.
        let flat: Vec<i32> = list(&pool, filters(me.user, me.account, "inbox", false))
            .await
            .iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(flat, vec![other, invite]);

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_long_conversation_lists_every_message_and_only_its_unread_ones() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let t = thread(&pool, me.account).await;
        let mut unread = Vec::new();
        for i in 0..105 {
            let id = email(
                &pool,
                me.account,
                Some(t),
                "Ann <ann@x.com>",
                &["INBOX"],
                &format!("2026-06-01 {:02}:{:02}", i / 60, i % 60),
            )
            .await;
            if i % 50 == 0 {
                sqlx::query("UPDATE emails SET is_read = FALSE WHERE id = $1")
                    .bind(id)
                    .execute(&pool)
                    .await
                    .unwrap_or_else(|e| panic!("unread: {e}"));
                unread.push(id);
            }
        }

        let rows = list(&pool, filters(me.user, me.account, "inbox", true)).await;
        assert_eq!(rows.len(), 1);
        // Every message, so deleting or reading the conversation covers it all.
        assert_eq!(rows[0].message_ids.as_ref().map(Vec::len), Some(105));
        assert_eq!(rows[0].unread_count, Some(3));
        // Only the unread ones, newest first, for "mark read".
        unread.reverse();
        assert_eq!(rows[0].unread_ids.as_deref(), Some(&unread[..]));

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn signal_and_noise_judge_a_conversation_by_its_newest_incoming_email() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        // Important thread you replied to: your reply mustn't move it to Noise.
        let t_signal = thread(&pool, me.account).await;
        email(
            &pool,
            me.account,
            Some(t_signal),
            "Ann <ann@x.com>",
            &["INBOX", "IMPORTANT"],
            "2026-09-01 09:00",
        )
        .await;
        email(
            &pool,
            me.account,
            Some(t_signal),
            &me.address,
            &["SENT"],
            "2026-09-02 09:00",
        )
        .await;
        // Was important once, but the newest incoming mail is a promotion.
        let t_noise = thread(&pool, me.account).await;
        email(
            &pool,
            me.account,
            Some(t_noise),
            "Shop <shop@x.com>",
            &["INBOX", "IMPORTANT"],
            "2026-09-03 09:00",
        )
        .await;
        email(
            &pool,
            me.account,
            Some(t_noise),
            "Shop <shop@x.com>",
            &["INBOX", "CATEGORY_PROMOTIONS"],
            "2026-09-04 09:00",
        )
        .await;

        let threads_in = |rows: Vec<EmailListRow>| -> Vec<Option<i32>> {
            rows.iter().map(|r| r.thread_id).collect()
        };
        let signal = threads_in(list(&pool, filters(me.user, me.account, "signal", true)).await);
        let noise = threads_in(list(&pool, filters(me.user, me.account, "noise", true)).await);
        assert_eq!(signal, vec![Some(t_signal)]);
        assert_eq!(noise, vec![Some(t_noise)]);

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn paging_through_conversations_has_no_gaps_or_repeats() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let mut expected = Vec::new();
        for day in 1..=5 {
            let t = thread(&pool, me.account).await;
            email(
                &pool,
                me.account,
                Some(t),
                "Ann <ann@x.com>",
                &["INBOX"],
                &format!("2026-08-0{day} 09:00"),
            )
            .await;
            // A later reply in each conversation, so its newest message is not
            // the one that matched the Inbox.
            let newest = email(
                &pool,
                me.account,
                Some(t),
                &me.address,
                &["SENT"],
                &format!("2026-08-0{day} 18:00"),
            )
            .await;
            expected.push(newest);
        }
        expected.reverse();

        let mut seen = Vec::new();
        let mut f = filters(me.user, me.account, "inbox", true);
        f.page_size = 2;
        loop {
            let page = list(&pool, f.clone()).await;
            let has_more = page.len() > f.page_size;
            let page: Vec<&EmailListRow> = page.iter().take(f.page_size).collect();
            seen.extend(page.iter().map(|r| r.id));
            let Some(last) = page.last() else { break };
            if !has_more {
                break;
            }
            let ms = last
                .created_at
                .unwrap_or_else(|| panic!("no date"))
                .and_utc()
                .timestamp_millis();
            f.before = Some((ms, last.id));
        }
        assert_eq!(seen, expected);

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn the_conversation_endpoint_is_oldest_first_and_owner_only() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let stranger = mailbox(&pool).await;
        let t = thread(&pool, me.account).await;
        let invite = email(
            &pool,
            me.account,
            Some(t),
            "Alice <alice@x.com>",
            &["INBOX"],
            "2026-07-19 10:00",
        )
        .await;
        let reply = email(
            &pool,
            me.account,
            Some(t),
            &me.address,
            &["SENT"],
            "2026-10-07 09:00",
        )
        .await;
        email(
            &pool,
            me.account,
            Some(t),
            "Alice <alice@x.com>",
            &["TRASH"],
            "2026-10-08 09:00",
        )
        .await;
        let lone = email(
            &pool,
            me.account,
            None,
            "Bob <bob@x.com>",
            &["INBOX"],
            "2026-09-01 09:00",
        )
        .await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::get_email_thread),
        )
        .await;
        let get = |id: i32, user: i32, email: &str| {
            actix_test::TestRequest::get()
                .uri(&format!("/emails/{id}/thread"))
                .insert_header(("Authorization", format!("Bearer {}", jwt_for(user, email))))
                .to_request()
        };
        let ids = |body: serde_json::Value| -> Vec<i64> {
            body.as_array()
                .map(|a| a.iter().filter_map(|m| m["id"].as_i64()).collect())
                .unwrap_or_default()
        };

        // Opening either message of the conversation gives the same history.
        for opened in [invite, reply] {
            let body: serde_json::Value =
                actix_test::call_and_read_body_json(&app, get(opened, me.user, &me.user_email))
                    .await;
            assert_eq!(ids(body), vec![i64::from(invite), i64::from(reply)]);
        }
        let body: serde_json::Value =
            actix_test::call_and_read_body_json(&app, get(lone, me.user, &me.user_email)).await;
        assert_eq!(ids(body), vec![i64::from(lone)]);

        // Someone else's email is simply not found.
        let resp =
            actix_test::call_service(&app, get(invite, stranger.user, &stranger.user_email)).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        cleanup(&pool, &[me.user, stranger.user]).await;
    }
}
