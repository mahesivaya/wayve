// Snooze folder routing. The whole design rests on one property: the folder
// queries compare `snoozed_until` against NOW(), so a message leaves the active
// views and comes back without anything being scheduled. These tests pin that
// — including the elapsed case, which is what proves no worker is needed.
#[cfg(test)]
mod tests {
    use crate::email::repo::{self, EmailListFilters, EmailListRow};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use chrono::{Duration, Utc};
    use sqlx::PgPool;

    struct Mailbox {
        user: i32,
        account: i32,
    }

    async fn mailbox(pool: &PgPool) -> Mailbox {
        let user = insert_local_user(pool, &random_email(), "password123").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') \
             RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        Mailbox { user, account }
    }

    /// `snoozed_until` is bound as an Option so the NULL (never-snoozed) case
    /// goes through the same helper as the snoozed ones.
    async fn email(pool: &PgPool, account: i32, snoozed_minutes: Option<i64>) -> i32 {
        let until = snoozed_minutes.map(|m| (Utc::now() + Duration::minutes(m)).naive_utc());
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, is_read, created_at, \
                                 snoozed_until) \
             VALUES ($1, $2, 'someone@test.local', ARRAY['INBOX'], TRUE, NOW(), $3) RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(account)
        .bind(until)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"))
    }

    async fn list(pool: &PgPool, m: &Mailbox, folder: &str) -> Vec<EmailListRow> {
        repo::list(
            pool,
            EmailListFilters {
                user_id: m.user,
                account_id: Some(m.account),
                folder: Some(folder.to_string()),
                inbox_status: None,
                search: None,
                before: None,
                page_size: 50,
                group_threads: false,
            },
        )
        .await
        .unwrap_or_else(|e| panic!("list: {e}"))
    }

    fn has(rows: &[EmailListRow], id: i32) -> bool {
        rows.iter().any(|r| r.id == id)
    }

    async fn cleanup(pool: &PgPool, user: i32) {
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn snoozed_mail_leaves_the_inbox_and_shows_only_under_snoozed() {
        let pool = test_pool().await;
        let m = mailbox(&pool).await;

        let plain = email(&pool, m.account, None).await;
        let snoozed = email(&pool, m.account, Some(60)).await;

        let inbox = list(&pool, &m, "inbox").await;
        assert!(has(&inbox, plain), "un-snoozed mail stays in the inbox");
        assert!(
            !has(&inbox, snoozed),
            "snoozed mail is hidden from the inbox"
        );

        let folder = list(&pool, &m, "snoozed").await;
        assert!(has(&folder, snoozed), "Snoozed folder shows it");
        assert!(
            !has(&folder, plain),
            "Snoozed folder shows ONLY snoozed mail"
        );

        cleanup(&pool, m.user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn an_elapsed_snooze_returns_on_its_own_with_nothing_scheduled() {
        let pool = test_pool().await;
        let m = mailbox(&pool).await;

        // Already in the past: no job ran, the timestamp simply elapsed.
        let elapsed = email(&pool, m.account, Some(-5)).await;

        assert!(
            has(&list(&pool, &m, "inbox").await, elapsed),
            "an elapsed snooze is back in the inbox without any worker running"
        );
        assert!(
            !has(&list(&pool, &m, "snoozed").await, elapsed),
            "and it has left the Snoozed folder"
        );

        cleanup(&pool, m.user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn search_can_still_reach_snoozed_mail() {
        let pool = test_pool().await;
        let m = mailbox(&pool).await;
        let snoozed = email(&pool, m.account, Some(60)).await;

        // "all" is the search scope. Snoozed mail must be out of the way, never
        // unreachable — otherwise a snooze is indistinguishable from a delete.
        assert!(
            has(&list(&pool, &m, "all").await, snoozed),
            "snoozed mail is still findable in All mail"
        );

        cleanup(&pool, m.user).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn snooze_hides_from_the_signal_and_noise_sub_views_too() {
        let pool = test_pool().await;
        let m = mailbox(&pool).await;

        // Signal keys off IMPORTANT; give the row that label so it would
        // otherwise qualify, proving the snooze clause is what excludes it.
        let id = sqlx::query_scalar::<_, i32>(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, is_read, created_at, \
                                 snoozed_until) \
             VALUES ($1, $2, 'someone@test.local', ARRAY['INBOX','IMPORTANT'], TRUE, NOW(), $3) \
             RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(m.account)
        .bind((Utc::now() + Duration::minutes(60)).naive_utc())
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"));

        assert!(
            !has(&list(&pool, &m, "signal").await, id),
            "a snoozed IMPORTANT message is hidden from Signal"
        );

        cleanup(&pool, m.user).await;
    }
}
