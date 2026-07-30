//! Tests for the compose "To" contacts projection: the sync-path upsert
//! (`email::contacts::record_from_addresses`), RLS isolation on `email_contacts`,
//! and the `GET /api/contacts/search` endpoint (auth, match, per-user scoping,
//! short-query, LIKE-metacharacter escaping).

#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    async fn make_account(pool: &PgPool, user_id: i32, email: &str) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'imap') RETURNING id",
        )
        .bind(email)
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("acct: {e}"))
    }

    async fn contact_count(pool: &PgPool, user_id: i32, address: &str) -> i32 {
        sqlx::query_scalar(
            "SELECT message_count FROM email_contacts WHERE user_id = $1 AND address = $2",
        )
        .bind(user_id)
        .bind(address)
        .fetch_optional(pool)
        .await
        .unwrap_or_else(|e| panic!("count: {e}"))
        .unwrap_or(0)
    }

    #[actix_web::test]
    async fn record_from_addresses_upserts_and_increments() {
        let pool = test_pool().await;
        let user = insert_local_user(&pool, &random_email(), "pw").await;
        let own = format!("own-{user}@mbox.test");
        let account = make_account(&pool, user, &own).await;

        // Sender is a correspondent; receiver is the account's own address (skipped).
        crate::email::contacts::record_from_addresses(
            &pool,
            account,
            vec!["Alice Chen <alice@acme.test>", own.as_str()],
        )
        .await;
        assert_eq!(contact_count(&pool, user, "alice@acme.test").await, 1);
        // Own address must not be recorded as a contact.
        assert_eq!(contact_count(&pool, user, &own.to_lowercase()).await, 0);

        // A second sighting increments the count.
        crate::email::contacts::record_from_addresses(&pool, account, vec!["alice@acme.test"])
            .await;
        assert_eq!(contact_count(&pool, user, "alice@acme.test").await, 2);

        // Cleanup.
        let _ = sqlx::query("DELETE FROM email_contacts WHERE user_id = $1")
            .bind(user)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM email_accounts WHERE id = $1")
            .bind(account)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(&pool)
            .await;
    }

    #[actix_web::test]
    async fn email_contacts_rls_isolates_users() {
        use sqlx::{Postgres, Transaction};
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;
        // Seed a contact for A as superuser (bypasses RLS).
        sqlx::query("INSERT INTO email_contacts (user_id, address) VALUES ($1, 'shared@x.test')")
            .bind(a)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("seed: {e}"));

        async fn begin_as(pool: &PgPool, uid: i32) -> Transaction<'_, Postgres> {
            let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
            sqlx::query("SELECT set_config('app.user_id', $1, true)")
                .bind(uid.to_string())
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("guc: {e}"));
            sqlx::query("SET LOCAL ROLE wayve_app")
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("role: {e}"));
            tx
        }

        let mut tx_a = begin_as(&pool, a).await;
        let seen_a: i64 = sqlx::query_scalar("SELECT count(*) FROM email_contacts")
            .fetch_one(&mut *tx_a)
            .await
            .unwrap_or_else(|e| panic!("a: {e}"));
        assert!(seen_a >= 1, "owner should see their own contact");
        drop(tx_a);

        let mut tx_b = begin_as(&pool, b).await;
        let seen_b: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM email_contacts WHERE address = 'shared@x.test'",
        )
        .fetch_one(&mut *tx_b)
        .await
        .unwrap_or_else(|e| panic!("b: {e}"));
        assert_eq!(seen_b, 0, "another user must not see A's contact");
        drop(tx_b);

        let _ = sqlx::query("DELETE FROM email_contacts WHERE user_id = $1")
            .bind(a)
            .execute(&pool)
            .await;
        for uid in [a, b] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
        }
    }

    #[actix_web::test]
    async fn contacts_search_requires_auth() {
        let pool = test_pool().await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool))
                .service(crate::routes::email::search_contacts),
        )
        .await;
        let req = actix_test::TestRequest::get()
            .uri("/contacts/search?q=al")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn contacts_search_matches_scopes_and_escapes() {
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;

        let needle = format!("cs{}", uuid::Uuid::new_v4().simple());
        let a_addr = format!("{needle}@match.test");
        // A's contact, B's contact (must not leak), and a literal-% guard.
        for (uid, addr, name) in [
            (a, a_addr.as_str(), "Match Person"),
            (b, "otheruser@b.test", "B Person"),
            (a, "plain@a.test", "Plain"),
        ] {
            sqlx::query(
                "INSERT INTO email_contacts (user_id, address, display_name) VALUES ($1, $2, $3)",
            )
            .bind(uid)
            .bind(addr)
            .bind(name)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("seed: {e}"));
        }

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::email::search_contacts),
        )
        .await;
        let bearer = format!("Bearer {}", jwt_for(a, "a@x.test"));

        // Short query → empty.
        let short = actix_test::TestRequest::get()
            .uri("/contacts/search?q=a")
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, short).await;
        assert_eq!(body, serde_json::json!([]));

        // Match by the needle → returns A's contact only.
        let hit = actix_test::TestRequest::get()
            .uri(&format!("/contacts/search?q={needle}"))
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, hit).await;
        let arr = body.as_array().unwrap_or_else(|| panic!("array"));
        assert_eq!(arr.len(), 1, "exactly A's matching contact");
        assert_eq!(arr[0]["address"], serde_json::json!(a_addr));
        assert_eq!(arr[0]["display_name"], serde_json::json!("Match Person"));

        // A literal '%%' query must not wildcard-match plain@a.test.
        let wild = actix_test::TestRequest::get()
            .uri("/contacts/search?q=%25%25")
            .insert_header(("Authorization", bearer))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, wild).await;
        assert_eq!(
            body,
            serde_json::json!([]),
            "'%' must be escaped, not treated as a wildcard"
        );

        for uid in [a, b] {
            let _ = sqlx::query("DELETE FROM email_contacts WHERE user_id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
        }
    }
}
