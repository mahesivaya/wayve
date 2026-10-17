// Snooze (Fluxze only), per person: the caller's own `email_snoozes` row hides
// a message from their inbox views while it is in the future and lets it back on its own once it passes,
// with nothing scheduled. Returned mail sorts at the top of the inbox, by when
// it came back, and pages correctly; elsewhere snoozed mail keeps its own date;
// Snoozed lists soonest-back first. A conversation's snooze is its newest
// message's, so a new reply brings it back, at the reply's place. Undoing a
// delete (a restore) keeps a snooze, and sync never clears one. In a shared
// inbox each member's snooze hides the email from them alone, and any member
// may snooze for themselves.
#[cfg(test)]
mod tests {
    use crate::email::repo::{self, EmailListFilters, EmailListRow, InsertEmail};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use chrono::{Duration, NaiveDateTime, Utc};
    use sqlx::PgPool;

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

    struct Mailbox {
        user: i32,
        login: String,
        account: i32,
    }

    async fn mailbox(pool: &PgPool) -> Mailbox {
        let login = random_email();
        let user = insert_local_user(pool, &login, "password123").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        Mailbox {
            user,
            login,
            account,
        }
    }

    fn ago(minutes: i64) -> NaiveDateTime {
        (Utc::now() - Duration::minutes(minutes)).naive_utc()
    }

    /// `user`'s own snooze of `email` until `until` (UTC).
    async fn snooze_for(pool: &PgPool, email: i32, user: i32, until: NaiveDateTime) {
        repo::set_snoozed(pool, email, user, Some(until))
            .await
            .unwrap_or_else(|e| panic!("snooze: {e}"));
    }

    /// The mailbox's owner, who a test email's snooze belongs to.
    async fn owner_of(pool: &PgPool, account: i32) -> i32 {
        sqlx::query_scalar("SELECT user_id FROM email_accounts WHERE id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("owner: {e}"))
    }

    /// An inbox email received `when`, optionally in a conversation, snoozed
    /// by the mailbox's owner until `snoozed` (UTC).
    async fn email(
        pool: &PgPool,
        account: i32,
        thread: Option<i32>,
        when: NaiveDateTime,
        snoozed: Option<NaiveDateTime>,
    ) -> i32 {
        let id = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, thread_id, sender, labels, created_at) \
             VALUES ($1, $2, $3, 'ada@x.com', ARRAY['INBOX']::text[], $4) RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(account)
        .bind(thread)
        .bind(when)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));
        if let Some(until) = snoozed {
            snooze_for(pool, id, owner_of(pool, account).await, until).await;
        }
        id
    }

    /// Like `email`, with Gmail labels of its own.
    async fn labelled(
        pool: &PgPool,
        account: i32,
        labels: &[&str],
        when: NaiveDateTime,
        snoozed: Option<NaiveDateTime>,
    ) -> i32 {
        let id = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, created_at) \
             VALUES ($1, $2, 'ada@x.com', $3, $4) RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(account)
        .bind(labels.iter().map(|l| l.to_string()).collect::<Vec<_>>())
        .bind(when)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));
        if let Some(until) = snoozed {
            snooze_for(pool, id, owner_of(pool, account).await, until).await;
        }
        id
    }

    fn filters(user: i32, folder: &str, grouped: bool) -> EmailListFilters {
        EmailListFilters {
            user_id: user,
            account_id: None,
            folder: Some(folder.to_string()),
            inbox_status: None,
            search: None,
            before: None,
            page_size: 200,
            group_threads: grouped,
        }
    }

    async fn list(pool: &PgPool, f: EmailListFilters) -> Vec<EmailListRow> {
        repo::list(pool, f)
            .await
            .unwrap_or_else(|e| panic!("list: {e}"))
    }

    async fn ids(pool: &PgPool, user: i32, folder: &str, grouped: bool) -> Vec<i32> {
        list(pool, filters(user, folder, grouped))
            .await
            .iter()
            .map(|row| row.id)
            .collect()
    }

    /// The email's snooze, in the single-person tests (anyone's).
    async fn snoozed_until(pool: &PgPool, id: i32) -> Option<NaiveDateTime> {
        sqlx::query_scalar("SELECT snoozed_until FROM email_snoozes WHERE email_id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap_or_else(|e| panic!("snoozed_until: {e}"))
    }

    /// One person's snooze of the email.
    async fn snoozed_for(pool: &PgPool, id: i32, user: i32) -> Option<NaiveDateTime> {
        sqlx::query_scalar(
            "SELECT snoozed_until FROM email_snoozes WHERE email_id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(user)
        .fetch_optional(pool)
        .await
        .unwrap_or_else(|e| panic!("snoozed_for: {e}"))
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
    async fn a_snoozed_email_leaves_the_inbox_for_snoozed_and_stays_in_all_mail() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let snoozed = email(&pool, me.account, None, ago(60), Some(ago(-30))).await;
        let other = email(&pool, me.account, None, ago(90), None).await;
        let newer = email(&pool, me.account, None, ago(10), None).await;

        for grouped in [false, true] {
            assert_eq!(ids(&pool, me.user, "inbox", grouped).await, [newer, other]);
            assert_eq!(ids(&pool, me.user, "snoozed", grouped).await, [snoozed]);
            // Out of the way, never unreachable, and at its own date: not at
            // the future moment it returns, above mail newer than it.
            assert_eq!(
                ids(&pool, me.user, "all", grouped).await,
                [newer, snoozed, other]
            );
        }

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_snooze_that_ran_out_is_back_at_the_top_with_nothing_run() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        // Received ten days ago, snoozed until a minute ago: back now, above
        // mail that arrived an hour ago.
        let returned = email(&pool, me.account, None, ago(60 * 24 * 10), Some(ago(1))).await;
        let recent = email(&pool, me.account, None, ago(60), None).await;

        for grouped in [false, true] {
            assert_eq!(
                ids(&pool, me.user, "inbox", grouped).await,
                [returned, recent]
            );
            assert!(ids(&pool, me.user, "snoozed", grouped).await.is_empty());
        }
        let rows = list(&pool, filters(me.user, "inbox", true)).await;
        assert_eq!(
            rows[0].sort_at, rows[0].snoozed_until,
            "sorted by its return"
        );
        assert_eq!(rows[1].sort_at, rows[1].created_at);

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn paging_follows_the_return_order() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let returned = email(&pool, me.account, None, ago(60 * 24 * 10), Some(ago(1))).await;
        let middle = email(&pool, me.account, None, ago(30), None).await;
        let oldest = email(&pool, me.account, None, ago(60 * 24 * 5), None).await;

        for grouped in [false, true] {
            let mut seen = Vec::new();
            let mut before = None;
            loop {
                let mut f = filters(me.user, "inbox", grouped);
                f.page_size = 1;
                f.before = before;
                let page = list(&pool, f).await;
                let Some(row) = page.first() else { break };
                seen.push(row.id);
                let sort_at = row.sort_at.unwrap_or_else(|| panic!("no sort_at"));
                before = Some((sort_at.and_utc().timestamp_millis(), row.id));
            }
            assert_eq!(seen, [returned, middle, oldest], "grouped = {grouped}");
        }

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_new_reply_brings_a_snoozed_conversation_back() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let thread: i32 =
            sqlx::query_scalar("INSERT INTO email_threads (account_id) VALUES ($1) RETURNING id")
                .bind(me.account)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("thread: {e}"));
        // Snoozing a conversation snoozes all its messages.
        let _first = email(&pool, me.account, Some(thread), ago(120), Some(ago(-60))).await;
        let second = email(&pool, me.account, Some(thread), ago(90), Some(ago(-60))).await;
        assert!(ids(&pool, me.user, "inbox", true).await.is_empty());
        assert_eq!(ids(&pool, me.user, "snoozed", true).await, [second]);

        // A reply arrives: the conversation is back, and only in the inbox, at
        // the reply's place. Its older messages' snooze hasn't ended, so it
        // must not hold the conversation above newer mail until it does.
        let reply = email(&pool, me.account, Some(thread), ago(10), None).await;
        let newer = email(&pool, me.account, None, ago(2), None).await;
        assert_eq!(ids(&pool, me.user, "inbox", true).await, [newer, reply]);
        assert!(ids(&pool, me.user, "snoozed", true).await.is_empty());

        cleanup(&pool, &[me.user]).await;
    }

    async fn call(
        pool: &PgPool,
        user: i32,
        login: &str,
        id: i32,
        until: Option<String>,
    ) -> StatusCode {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::snooze_email)
                .service(crate::routes::email::unsnooze_email),
        )
        .await;
        let auth = ("Authorization", format!("Bearer {}", jwt_for(user, login)));
        let req = match until {
            Some(until) => actix_test::TestRequest::post()
                .uri(&format!("/emails/{id}/snooze"))
                .insert_header(auth)
                .set_json(serde_json::json!({ "until": until })),
            None => actix_test::TestRequest::post()
                .uri(&format!("/emails/{id}/unsnooze"))
                .insert_header(auth),
        }
        .to_request();
        actix_test::call_service(&app, req).await.status()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn the_endpoints_store_the_exact_moment_and_refuse_bad_times_and_strangers() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let stranger = mailbox(&pool).await;
        let id = email(&pool, me.account, None, ago(60), None).await;

        // 10:30 in Kolkata (+05:30) is 05:00 UTC: stored as the moment, not the
        // wall-clock time.
        let tomorrow = (Utc::now() + Duration::days(1)).date_naive();
        let kolkata = format!("{tomorrow}T10:30:00+05:30");
        assert_eq!(
            call(
                &pool,
                stranger.user,
                &stranger.login,
                id,
                Some(kolkata.clone())
            )
            .await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(snoozed_until(&pool, id).await, None);
        assert_eq!(
            call(&pool, me.user, &me.login, id, Some(kolkata)).await,
            StatusCode::OK
        );
        let expected = tomorrow
            .and_hms_opt(5, 0, 0)
            .unwrap_or_else(|| panic!("time"));
        assert_eq!(snoozed_until(&pool, id).await, Some(expected));
        assert!(!ids(&pool, me.user, "inbox", true).await.contains(&id));

        let past = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        let too_far = (Utc::now() + Duration::days(400)).to_rfc3339();
        for bad in [past, too_far] {
            assert_eq!(
                call(&pool, me.user, &me.login, id, Some(bad)).await,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(snoozed_until(&pool, id).await, Some(expected), "unchanged");

        // Unsnooze drops it: back in the inbox at its own place.
        assert_eq!(
            call(&pool, me.user, &me.login, id, None).await,
            StatusCode::OK
        );
        assert_eq!(snoozed_until(&pool, id).await, None);
        assert!(ids(&pool, me.user, "inbox", true).await.contains(&id));

        let audited: Vec<String> = sqlx::query_scalar(
            "SELECT action FROM audit_logs WHERE resource_id = $1 AND actor_user_id = $2 ORDER BY id",
        )
        .bind(id.to_string())
        .bind(me.user)
        .fetch_all(&pool)
        .await
        .unwrap_or_else(|e| panic!("audit: {e}"));
        assert_eq!(audited, ["email_snoozed", "email_unsnoozed"]);

        // Unsnoozing a snooze that already ended changes nothing and isn't
        // recorded: it is what keeps returned mail at the top.
        let returned = email(&pool, me.account, None, ago(60 * 24), Some(ago(5))).await;
        assert_eq!(
            call(&pool, me.user, &me.login, returned, None).await,
            StatusCode::OK
        );
        assert!(snoozed_until(&pool, returned).await.is_some());
        let recorded: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_logs WHERE resource_id = $1 AND action = 'email_unsnoozed'",
        )
        .bind(returned.to_string())
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("audit: {e}"));
        assert_eq!(recorded, 0);

        cleanup(&pool, &[me.user, stranger.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn snoozed_lists_soonest_back_first_and_pages_that_way() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let later = email(&pool, me.account, None, ago(5), Some(ago(-90))).await;
        let soon = email(&pool, me.account, None, ago(50), Some(ago(-10))).await;
        let middle = email(&pool, me.account, None, ago(20), Some(ago(-45))).await;

        for grouped in [false, true] {
            assert_eq!(
                ids(&pool, me.user, "snoozed", grouped).await,
                [soon, middle, later]
            );
            let mut seen = Vec::new();
            let mut before = None;
            loop {
                let mut f = filters(me.user, "snoozed", grouped);
                f.page_size = 1;
                f.before = before;
                let page = list(&pool, f).await;
                let Some(row) = page.first() else { break };
                assert_eq!(row.sort_at, row.snoozed_until, "paged on the return");
                seen.push(row.id);
                let sort_at = row.sort_at.unwrap_or_else(|| panic!("no sort_at"));
                before = Some((sort_at.and_utc().timestamp_millis(), row.id));
            }
            assert_eq!(seen, [soon, middle, later], "grouped = {grouped}");
        }

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn signal_noise_and_reviews_hide_snoozed_mail_too() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let until = Some(ago(-30));
        let signal = labelled(&pool, me.account, &["INBOX", "IMPORTANT"], ago(5), until).await;
        let noise = labelled(
            &pool,
            me.account,
            &["INBOX", "CATEGORY_SOCIAL"],
            ago(6),
            until,
        )
        .await;
        let review = labelled(
            &pool,
            me.account,
            &["INBOX", "WAYVE_GITHUB_PR"],
            ago(7),
            until,
        )
        .await;
        for grouped in [false, true] {
            for (folder, id) in [("signal", signal), ("noise", noise), ("github", review)] {
                assert!(
                    !ids(&pool, me.user, folder, grouped).await.contains(&id),
                    "{folder} (grouped = {grouped}) lists snoozed mail"
                );
            }
            // A label folder still lists it, at its own date.
            assert!(
                ids(&pool, me.user, "important", grouped)
                    .await
                    .contains(&signal)
            );
        }

        cleanup(&pool, &[me.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn undoing_a_delete_keeps_the_snooze() {
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        // Fluxze-to-Fluxze mail, so delete and restore need no provider.
        let native = |snoozed: Option<NaiveDateTime>| {
            let pool = pool.clone();
            async move {
                let id = sqlx::query_scalar::<_, i32>(
                    "INSERT INTO emails (gmail_id, account_id, sender, labels, source, \
                                         recipient_user_id, created_at) \
                     VALUES ($1, NULL, 'ada@x.com', ARRAY['INBOX']::text[], 'wayve', $2, $3) \
                     RETURNING id",
                )
                .bind(format!("wayve:test:{}", random_email()))
                .bind(me.user)
                .bind(ago(60))
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("email: {e}"));
                if let Some(until) = snoozed {
                    snooze_for(&pool, id, me.user, until).await;
                }
                id
            }
        };
        let pending_until = ago(-30);
        let pending = native(Some(pending_until)).await;
        let ended = native(Some(ago(5))).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::delete_email)
                .service(crate::routes::email::restore_email),
        )
        .await;
        let auth = || {
            (
                "Authorization",
                format!("Bearer {}", jwt_for(me.user, &me.login)),
            )
        };
        for id in [pending, ended] {
            let delete = actix_test::TestRequest::delete()
                .uri(&format!("/emails/{id}"))
                .insert_header(auth())
                .to_request();
            assert_eq!(
                actix_test::call_service(&app, delete).await.status(),
                StatusCode::OK
            );
            // The "Moved to Trash · Undo" button is this restore.
            let undo = actix_test::TestRequest::post()
                .uri(&format!("/emails/{id}/restore"))
                .insert_header(auth())
                .to_request();
            assert_eq!(
                actix_test::call_service(&app, undo).await.status(),
                StatusCode::OK
            );
        }

        // Back exactly as it was: still snoozed, so in Snoozed and not the
        // inbox, and it returns on time.
        let kept = snoozed_until(&pool, pending)
            .await
            .unwrap_or_else(|| panic!("undo cleared the snooze"));
        assert!((kept - pending_until).num_milliseconds().abs() < 1);
        for grouped in [false, true] {
            assert!(
                ids(&pool, me.user, "snoozed", grouped)
                    .await
                    .contains(&pending)
            );
            assert!(
                !ids(&pool, me.user, "inbox", grouped)
                    .await
                    .contains(&pending)
            );
        }
        // A snooze that already ended keeps the email at the top.
        assert!(snoozed_until(&pool, ended).await.is_some());
        assert_eq!(
            ids(&pool, me.user, "inbox", true).await.first(),
            Some(&ended)
        );

        cleanup(&pool, &[me.user]).await;
    }

    /// A shared inbox: `owner`'s mailbox, with `member` added to it.
    async fn share(pool: &PgPool, owner: &Mailbox) -> (i32, String) {
        let login = random_email();
        let member = insert_local_user(pool, &login, "password123").await;
        sqlx::query("UPDATE email_accounts SET is_shared = TRUE WHERE id = $1")
            .bind(owner.account)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("share: {e}"));
        sqlx::query("INSERT INTO shared_inbox_members (account_id, user_id) VALUES ($1, $2)")
            .bind(owner.account)
            .bind(member)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("member: {e}"));
        (member, login)
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn in_a_shared_inbox_a_snooze_hides_the_email_from_its_snoozer_only() {
        let pool = test_pool().await;
        let owner = mailbox(&pool).await;
        let (member, _) = share(&pool, &owner).await;
        // The owner snoozes it: one email row, seen by both.
        let id = email(&pool, owner.account, None, ago(60), Some(ago(-30))).await;

        for grouped in [false, true] {
            assert!(!ids(&pool, owner.user, "inbox", grouped).await.contains(&id));
            assert!(
                ids(&pool, owner.user, "snoozed", grouped)
                    .await
                    .contains(&id)
            );
            // The member still has it, and nothing in their Snoozed.
            assert!(ids(&pool, member, "inbox", grouped).await.contains(&id));
            assert!(ids(&pool, member, "snoozed", grouped).await.is_empty());
        }
        let row = list(&pool, filters(member, "inbox", true)).await;
        assert_eq!(row[0].snoozed_until, None, "the owner's snooze leaked");

        cleanup(&pool, &[owner.user, member]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_shared_inbox_member_snoozes_for_themselves() {
        let pool = test_pool().await;
        let owner = mailbox(&pool).await;
        let (member, member_login) = share(&pool, &owner).await;
        let stranger = mailbox(&pool).await;
        let id = email(&pool, owner.account, None, ago(60), None).await;
        let until = (Utc::now() + Duration::minutes(30)).to_rfc3339();

        // Members could only get 404 here before.
        assert_eq!(
            call(&pool, member, &member_login, id, Some(until.clone())).await,
            StatusCode::OK
        );
        assert!(snoozed_for(&pool, id, member).await.is_some());
        assert_eq!(snoozed_for(&pool, id, owner.user).await, None);
        assert!(!ids(&pool, member, "inbox", true).await.contains(&id));
        assert!(ids(&pool, owner.user, "inbox", true).await.contains(&id));

        // Someone outside the shared inbox still can't touch it.
        assert_eq!(
            call(&pool, stranger.user, &stranger.login, id, Some(until)).await,
            StatusCode::NOT_FOUND
        );

        // Unsnoozing ends the member's snooze only.
        snooze_for(&pool, id, owner.user, ago(-60)).await;
        assert_eq!(
            call(&pool, member, &member_login, id, None).await,
            StatusCode::OK
        );
        assert_eq!(snoozed_for(&pool, id, member).await, None);
        assert!(snoozed_for(&pool, id, owner.user).await.is_some());
        assert!(ids(&pool, member, "inbox", true).await.contains(&id));
        assert!(!ids(&pool, owner.user, "inbox", true).await.contains(&id));

        cleanup(&pool, &[owner.user, member, stranger.user]).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_resync_never_clears_a_snooze() {
        ensure_aes_key();
        let pool = test_pool().await;
        let me = mailbox(&pool).await;
        let labels = ["INBOX".to_string()];
        let row = InsertEmail {
            gmail_id: "g-resync",
            sender: "ada@x.com",
            receiver: "me@x.com",
            cc: None,
            subject: "Plans",
            created_at: ago(60),
            is_read: false,
            labels: &labels,
            body: None,
            attachments_checked: true,
        };
        let id = repo::upsert_one(&pool, me.account, &row)
            .await
            .unwrap_or_else(|e| panic!("upsert: {e}"));
        let until = ago(-30);
        snooze_for(&pool, id, me.user, until).await;
        repo::upsert_one(&pool, me.account, &row)
            .await
            .unwrap_or_else(|e| panic!("resync: {e}"));
        let stored = snoozed_until(&pool, id)
            .await
            .unwrap_or_else(|| panic!("a resync cleared the snooze"));
        // Postgres keeps microseconds; chrono may carry nanoseconds.
        assert!((stored - until).num_milliseconds().abs() < 1);

        cleanup(&pool, &[me.user]).await;
    }
}
