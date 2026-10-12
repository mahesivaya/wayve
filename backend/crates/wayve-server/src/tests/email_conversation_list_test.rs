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
        mailbox_on(pool, "google").await
    }

    async fn mailbox_on(pool: &PgPool, provider: &str) -> Mailbox {
        let user_email = random_email();
        let user = insert_local_user(pool, &user_email, "password123").await;
        let address = random_email();
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(&address)
        .bind(user)
        .bind(provider)
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
        // Who wrote in it, once each, oldest first (the trashed message left
        // out), so the row can read "Alice, me" rather than just your reply.
        let who: Option<Vec<String>> = rows[0]
            .participants
            .as_ref()
            .map(|p| p.iter().map(|p| p.sender.clone()).collect());
        assert_eq!(
            who,
            Some(vec!["Alice <alice@x.com>".to_string(), me.address.clone()])
        );
        // Each person is bold only while one of their messages is unread.
        sqlx::query("UPDATE emails SET is_read = FALSE WHERE id = $1")
            .bind(invite)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("unread: {e}"));
        let rows = list(&pool, filters(me.user, me.account, "inbox", true)).await;
        let unread: Option<Vec<bool>> = rows[0]
            .participants
            .as_ref()
            .map(|p| p.iter().map(|p| p.unread).collect());
        assert_eq!(unread, Some(vec![true, false]));
        sqlx::query("UPDATE emails SET is_read = TRUE WHERE id = $1")
            .bind(invite)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("read: {e}"));
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
        assert!(
            list(&pool, filters(me.user, me.account, "inbox", false))
                .await
                .iter()
                .all(|r| r.participants.is_none()),
            "only conversation rows carry participants"
        );

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

    // Sync pulls all of Gmail, so archived and filter-skipped mail is stored
    // too. Only INBOX-labelled Gmail mail belongs in the Inbox and its chips,
    // as in Gmail; a provider without labels (IMAP) keeps the sender rule.
    #[actix_web::test]
    #[serial_test::serial]
    async fn gmail_mail_outside_the_inbox_stays_out_of_it() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let inbox = email(
            &pool,
            me.account,
            None,
            "Ann <ann@x.com>",
            &["INBOX", "IMPORTANT"],
            "2026-09-01 09:00",
        )
        .await;
        // Archived, or skipped by a Gmail filter: never in the Inbox, Signal
        // or Noise, even though someone else sent it.
        for labels in [
            &["Label_1"][..],
            &["IMPORTANT"][..],
            &["CATEGORY_PROMOTIONS"][..],
            &[][..],
        ] {
            email(
                &pool,
                me.account,
                None,
                "Recruiter <jobs@x.com>",
                labels,
                "2026-09-05 09:00",
            )
            .await;
        }
        // A conversation still in the inbox keeps its row when a newer message
        // of it was archived, and the row shows that newest message.
        let t = thread(&pool, me.account).await;
        email(
            &pool,
            me.account,
            Some(t),
            "Bob <bob@x.com>",
            &["INBOX", "IMPORTANT"],
            "2026-09-02 09:00",
        )
        .await;
        let archived_reply = email(
            &pool,
            me.account,
            Some(t),
            "Bob <bob@x.com>",
            &["CATEGORY_PROMOTIONS"],
            "2026-09-03 09:00",
        )
        .await;

        let ids = |rows: Vec<EmailListRow>| -> Vec<i32> { rows.iter().map(|r| r.id).collect() };
        let grouped = ids(list(&pool, filters(me.user, me.account, "inbox", true)).await);
        assert_eq!(grouped, vec![archived_reply, inbox]);
        let flat = ids(list(&pool, filters(me.user, me.account, "inbox", false)).await);
        assert_eq!(flat.len(), 2, "only the two INBOX messages: {flat:?}");
        assert!(flat.contains(&inbox));

        // Signal judges by the newest incoming message still in the inbox, so
        // the archived promotion doesn't move Bob's conversation to Noise.
        let signal = ids(list(&pool, filters(me.user, me.account, "signal", true)).await);
        assert_eq!(signal, vec![archived_reply, inbox]);
        let noise = list(&pool, filters(me.user, me.account, "noise", true)).await;
        assert!(noise.is_empty(), "noise: {:?}", ids(noise));
        let flat_noise = list(&pool, filters(me.user, me.account, "noise", false)).await;
        assert!(flat_noise.is_empty(), "flat noise: {:?}", ids(flat_noise));

        // The local unread fallback counts the same way.
        sqlx::query("UPDATE emails SET is_read = FALSE WHERE account_id = $1")
            .bind(me.account)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("unread: {e}"));
        let accounts = crate::email::account::load_account_summaries_for_user(&pool, me.user)
            .await
            .unwrap_or_else(|e| panic!("accounts: {e}"));
        let unread = serde_json::to_value(&accounts).unwrap_or_else(|e| panic!("json: {e}"))[0]
            ["unread_count"]
            .as_i64();
        assert_eq!(unread, Some(2));
        // And so does the nav badge, which must equal the account's.
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::get_unread_count),
        )
        .await;
        let req = actix_test::TestRequest::get()
            .uri("/emails/unread-count")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(me.user, &me.user_email)),
            ))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["count"].as_i64(), Some(2), "badge: {body}");

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn label_less_imap_mail_from_others_is_still_in_the_inbox() {
        let pool = test_pool().await;
        let me = mailbox_on(&pool, "imap").await;
        let incoming = email(
            &pool,
            me.account,
            None,
            "Ann <ann@x.com>",
            &[],
            "2026-09-01 09:00",
        )
        .await;
        email(
            &pool,
            me.account,
            None,
            &me.address,
            &[],
            "2026-09-02 09:00",
        )
        .await;

        for grouped in [true, false] {
            let rows = list(&pool, filters(me.user, me.account, "inbox", grouped)).await;
            let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
            assert_eq!(ids, vec![incoming], "grouped = {grouped}");
        }

        cleanup(&pool, &[me.user]).await;
    }

    // Scrolling the Inbox past the local copy fetches older mail from Gmail.
    // Fetching all mail there would bring archived pages that fill nothing, so
    // a run of them could end the scroll early: it asks Gmail for INBOX only.
    #[actix_web::test]
    #[serial_test::serial]
    async fn the_inbox_older_sync_asks_gmail_for_inbox_mail_only() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        // SAFETY: serialized via #[serial].
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
        let mock = MockServer::start().await;
        let list = |ids: &[&str]| serde_json::json!({ "messages": ids.iter().map(|id| serde_json::json!({ "id": id })).collect::<Vec<_>>() });
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .and(query_param("labelIds", "INBOX"))
            .respond_with(ResponseTemplate::new(200).set_body_json(list(&["in1"])))
            .with_priority(1)
            .expect(1)
            .mount(&mock)
            .await;
        // What an all-mail page would hold: never requested.
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(list(&["arch1", "arch2"])))
            .expect(0)
            .mount(&mock)
            .await;
        for (id, label) in [("in1", "INBOX"), ("arch1", "Label_1"), ("arch2", "Label_1")] {
            Mock::given(method("GET"))
                .and(path(format!("/gmail/v1/users/me/messages/{id}")))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "id": id, "threadId": id, "labelIds": [label], "internalDate": "1700000000000",
                    "payload": { "headers": [
                        { "name": "From", "value": "ann@x.com" },
                        { "name": "Subject", "value": "Hi" }
                    ]}
                })))
                .mount(&mock)
                .await;
        }
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("GMAIL_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let synced = crate::email::sync::sync_account_inbox_before(
            &pool,
            me.account,
            "tok",
            1_800_000_000,
            26,
        )
        .await;
        unsafe {
            std::env::remove_var("GMAIL_API_BASE");
        }
        synced.unwrap_or_else(|e| panic!("sync: {e}"));

        let stored: Vec<String> =
            sqlx::query_scalar("SELECT gmail_id FROM emails WHERE account_id = $1")
                .bind(me.account)
                .fetch_all(&pool)
                .await
                .unwrap_or_else(|e| panic!("stored: {e}"));
        assert_eq!(stored, vec!["in1".to_string()]);
        mock.verify().await;

        cleanup(&pool, &[me.user]).await;
    }

    // All mail (what every search reads) lists the archived and filter-skipped
    // Gmail mail the Inbox leaves out, but never spam, drafts or trash.
    #[actix_web::test]
    #[serial_test::serial]
    async fn all_mail_lists_archived_gmail_mail_but_not_spam_drafts_or_trash() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let inbox = email(
            &pool,
            me.account,
            None,
            "Ann <ann@x.com>",
            &["INBOX"],
            "2026-09-01 09:00",
        )
        .await;
        let archived = email(
            &pool,
            me.account,
            None,
            "Recruiter <jobs@x.com>",
            &["Label_1"],
            "2026-09-02 09:00",
        )
        .await;
        let sent = email(
            &pool,
            me.account,
            None,
            &me.address,
            &["SENT"],
            "2026-09-03 09:00",
        )
        .await;
        for label in ["SPAM", "DRAFT", "TRASH"] {
            email(
                &pool,
                me.account,
                None,
                "Ann <ann@x.com>",
                &[label],
                "2026-09-04 09:00",
            )
            .await;
        }

        for grouped in [true, false] {
            let ids: Vec<i32> = list(&pool, filters(me.user, me.account, "all", grouped))
                .await
                .iter()
                .map(|r| r.id)
                .collect();
            assert_eq!(ids, vec![sent, archived, inbox], "grouped = {grouped}");
        }
        // A search finds the archived message there, not in the Inbox.
        let mut search = filters(me.user, me.account, "all", true);
        search.search = Some("jobs@x.com".to_string());
        let found: Vec<i32> = list(&pool, search.clone())
            .await
            .iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(found, vec![archived]);
        search.folder = Some("inbox".to_string());
        assert!(list(&pool, search).await.is_empty());

        cleanup(&pool, &[me.user]).await;
    }

    // Opening an older Gmail conversation fetches the messages it is missing —
    // your reply, an archived message — into the same conversation, once.
    #[actix_web::test]
    #[serial_test::serial]
    async fn opening_a_conversation_completes_it_from_gmail_once() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        // SAFETY: serialized via #[serial].
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let stranger = mailbox(&pool).await;

        let mock = MockServer::start().await;
        let metadata = |id: &str, from: &str, labels: &[&str], ms: &str| {
            serde_json::json!({
                "id": id, "threadId": "T9", "labelIds": labels, "internalDate": ms,
                "payload": { "headers": [
                    { "name": "From", "value": from },
                    { "name": "To", "value": "ann@x.com" },
                    { "name": "Subject", "value": "Plans" }
                ]}
            })
        };
        for (id, from, labels, ms) in [
            ("known", "Ann <ann@x.com>", &["INBOX"][..], "1780000000000"),
            (
                "reply1",
                me.address.as_str(),
                &["SENT"][..],
                "1780000100000",
            ),
            (
                "arch1",
                "Ann <ann@x.com>",
                &["Label_1"][..],
                "1780000200000",
            ),
        ] {
            Mock::given(method("GET"))
                .and(path(format!("/gmail/v1/users/me/messages/{id}")))
                .and(query_param("format", "metadata"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_json(metadata(id, from, labels, ms)),
                )
                .mount(&mock)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/known"))
            .and(query_param("format", "minimal"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "known", "threadId": "T9" })),
            )
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/threads/T9"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "T9",
                "messages": [{ "id": "known" }, { "id": "reply1" }, { "id": "arch1" }]
            })))
            .expect(1)
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("GMAIL_API_BASE", mock.uri());
        }

        // The inbox message is stored (and threaded) the way sync stores it.
        let stored =
            crate::email::sync::sync_ids(&pool, me.account, "tok", vec!["known".into()]).await;
        let (known, thread): (i32, i32) = sqlx::query_as(
            "SELECT id, thread_id FROM emails WHERE account_id = $1 AND gmail_id = 'known'",
        )
        .bind(me.account)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("known: {e}"));
        // Someone else's conversation is never completed for them.
        let other =
            crate::email::complete::complete_conversation(&pool, stranger.user, known).await;
        let fetched =
            crate::email::complete::store_missing(&pool, me.account, thread, "known", "tok").await;
        unsafe {
            std::env::remove_var("GMAIL_API_BASE");
        }
        stored.unwrap_or_else(|e| panic!("sync: {e}"));
        assert!(!other.unwrap_or_else(|e| panic!("other: {e}")));
        assert!(fetched.unwrap_or_else(|e| panic!("complete: {e}")));
        mock.verify().await;

        let messages: Vec<String> = repo::thread_messages(&pool, known, me.user)
            .await
            .unwrap_or_else(|e| panic!("thread: {e}"))
            .into_iter()
            .map(|m| m.gmail_id)
            .collect();
        assert_eq!(messages, vec!["known", "reply1", "arch1"], "oldest first");

        // Done once: a later open fetches nothing, without a provider call.
        let again = crate::email::complete::complete_conversation(&pool, me.user, known).await;
        assert!(!again.unwrap_or_else(|e| panic!("again: {e}")));

        cleanup(&pool, &[me.user, stranger.user]).await;
    }
}
