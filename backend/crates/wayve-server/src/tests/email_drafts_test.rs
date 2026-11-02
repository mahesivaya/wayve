// Half-written emails (email::drafts): saved and listed through the real handlers,
// sealed at rest, private to their owner both at the handler and under RLS, and
// bounded so autosave can't grow without limit.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::Method, http::StatusCode, test as actix_test, web};
    use serde_json::{Value, json};
    use sqlx::PgPool;

    const SECRET_BODY: &str = "the merger closes on friday";

    fn set_key() {
        // SAFETY: mirrors the other encryption tests; CI runs single-threaded.
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var("AES_KEY", "a".repeat(64));
            }
        }
    }

    async fn user(pool: &PgPool) -> (i32, String) {
        set_key();
        let login = random_email();
        (insert_local_user(pool, &login, "password123").await, login)
    }

    async fn mailbox(pool: &PgPool, owner: i32) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider, is_active) \
             VALUES ($1, $2, 'google', false) RETURNING id",
        )
        .bind(random_email())
        .bind(owner)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"))
    }

    /// Fluxze-to-Fluxze mail for `recipient`, visible to them with no provider.
    async fn native_email(pool: &PgPool, recipient: i32) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, labels, source, recipient_user_id) \
             VALUES ($1, NULL, 'ada@x.com', ARRAY['INBOX']::text[], 'wayve', $2) RETURNING id",
        )
        .bind(format!("wayve:test:{}", random_email()))
        .bind(recipient)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"))
    }

    async fn call(
        pool: &PgPool,
        who: &(i32, String),
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::email::drafts::list_drafts)
                .service(crate::email::drafts::create_draft)
                .service(crate::email::drafts::update_draft)
                .service(crate::email::drafts::delete_draft),
        )
        .await;
        let mut req = actix_test::TestRequest::default()
            .method(method)
            .uri(uri)
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(who.0, &who.1)),
            ));
        if let Some(body) = body {
            req = req.set_json(body);
        }
        let resp = actix_test::call_service(&app, req.to_request()).await;
        let status = resp.status();
        let bytes = actix_test::read_body(resp).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn compose(body: &str) -> Value {
        json!({ "kind": "compose", "to": "bob@x.com", "subject": "Hello", "body": body })
    }

    async fn create(pool: &PgPool, who: &(i32, String), body: Value) -> (StatusCode, Value) {
        call(pool, who, Method::POST, "/email/drafts", Some(body)).await
    }

    fn id_of(draft: &Value) -> i64 {
        draft["id"]
            .as_i64()
            .unwrap_or_else(|| panic!("no id in {draft}"))
    }

    #[actix_web::test]
    async fn saves_lists_updates_and_deletes() {
        let pool = test_pool().await;
        let me = user(&pool).await;

        let (status, draft) = create(&pool, &me, compose("first")).await;
        assert_eq!(status, StatusCode::OK, "{draft}");
        assert_eq!(draft["body"], "first");
        assert_eq!(draft["to"], "bob@x.com");
        assert_eq!(draft["cc"], "");
        let id = id_of(&draft);

        let (status, updated) = call(
            &pool,
            &me,
            Method::PUT,
            &format!("/email/drafts/{id}"),
            Some(json!({ "to": "carol@x.com", "subject": "Hi", "body": "second" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{updated}");
        assert_eq!(id_of(&updated), id);
        assert_eq!(updated["to"], "carol@x.com");

        let (_, listed) = call(&pool, &me, Method::GET, "/email/drafts", None).await;
        assert_eq!(listed.as_array().map(Vec::len), Some(1), "{listed}");
        assert_eq!(listed[0]["body"], "second");

        let (status, _) = call(
            &pool,
            &me,
            Method::DELETE,
            &format!("/email/drafts/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        // Discarding again, say from a second tab, isn't an error.
        let (status, _) = call(
            &pool,
            &me,
            Method::DELETE,
            &format!("/email/drafts/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, listed) = call(&pool, &me, Method::GET, "/email/drafts", None).await;
        assert_eq!(listed, json!([]));
    }

    #[actix_web::test]
    async fn nothing_readable_is_stored() {
        let pool = test_pool().await;
        let me = user(&pool).await;
        let (_, draft) = create(&pool, &me, compose(SECRET_BODY)).await;

        let row: (String, String) =
            sqlx::query_as("SELECT content_iv, content_encrypted FROM email_drafts WHERE id = $1")
                .bind(id_of(&draft) as i32)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("row: {e}"));
        assert!(!row.1.contains(SECRET_BODY));
        assert!(!row.1.contains("bob@x.com"));
        assert!(!row.0.is_empty());
        let columns: Vec<String> = sqlx::query_scalar(
            "SELECT column_name::text FROM information_schema.columns \
             WHERE table_name = 'email_drafts'",
        )
        .fetch_all(&pool)
        .await
        .unwrap_or_else(|e| panic!("columns: {e}"));
        for plain in ["to", "cc", "bcc", "subject", "body"] {
            assert!(!columns.iter().any(|c| c == plain), "plaintext {plain}");
        }
    }

    #[actix_web::test]
    async fn a_source_email_has_one_draft_per_kind() {
        let pool = test_pool().await;
        let me = user(&pool).await;
        let source = native_email(&pool, me.0).await;
        let reply = |body: &str| json!({ "kind": "reply", "source_email_id": source, "to": "a@x.com", "body": body });

        let (status, first) = create(&pool, &me, reply("one")).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        // A second tab's save joins the same draft instead of adding a rival.
        let (_, second) = create(&pool, &me, reply("two")).await;
        assert_eq!(id_of(&first), id_of(&second));
        assert_eq!(second["body"], "two");
        // A forward of the same email is its own draft.
        let (_, forward) = create(
            &pool,
            &me,
            json!({ "kind": "forward", "source_email_id": source, "body": "fwd" }),
        )
        .await;
        assert_ne!(id_of(&first), id_of(&forward));
        // New emails have no source, so any number can exist.
        let (_, a) = create(&pool, &me, compose("a")).await;
        let (_, b) = create(&pool, &me, compose("b")).await;
        assert_ne!(id_of(&a), id_of(&b));
    }

    #[actix_web::test]
    async fn rejects_a_kind_and_source_that_dont_fit() {
        let pool = test_pool().await;
        let me = user(&pool).await;
        let source = native_email(&pool, me.0).await;
        for bad in [
            json!({ "kind": "reply", "body": "x" }),
            json!({ "kind": "forward", "body": "x" }),
            json!({ "kind": "compose", "source_email_id": source, "body": "x" }),
            json!({ "kind": "nonsense", "body": "x" }),
        ] {
            let (status, _) = create(&pool, &me, bad.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    #[actix_web::test]
    async fn another_users_draft_is_out_of_reach() {
        let pool = test_pool().await;
        let me = user(&pool).await;
        let other = user(&pool).await;
        let (_, mine) = create(&pool, &me, compose(SECRET_BODY)).await;
        let id = id_of(&mine);

        let (_, theirs) = call(&pool, &other, Method::GET, "/email/drafts", None).await;
        assert_eq!(theirs, json!([]));
        let (status, _) = call(
            &pool,
            &other,
            Method::PUT,
            &format!("/email/drafts/{id}"),
            Some(json!({ "body": "stolen" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = call(
            &pool,
            &other,
            Method::DELETE,
            &format!("/email/drafts/{id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (_, still) = call(&pool, &me, Method::GET, "/email/drafts", None).await;
        assert_eq!(still[0]["body"], SECRET_BODY, "{still}");
    }

    #[actix_web::test]
    async fn cant_attach_someone_elses_email_or_mailbox() {
        let pool = test_pool().await;
        let me = user(&pool).await;
        let other = user(&pool).await;
        let their_email = native_email(&pool, other.0).await;
        let their_box = mailbox(&pool, other.0).await;
        let my_box = mailbox(&pool, me.0).await;

        let (status, _) = create(
            &pool,
            &me,
            json!({ "kind": "reply", "source_email_id": their_email, "body": "x" }),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = create(
            &pool,
            &me,
            json!({ "kind": "compose", "account_id": their_box, "body": "x" }),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, draft) = create(
            &pool,
            &me,
            json!({ "kind": "compose", "account_id": my_box, "body": "x" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{draft}");
        assert_eq!(draft["account_id"], my_box);
        let (status, _) = call(
            &pool,
            &me,
            Method::PUT,
            &format!("/email/drafts/{}", id_of(&draft)),
            Some(json!({ "account_id": their_box, "body": "x" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[actix_web::test]
    async fn losing_the_original_keeps_what_was_written() {
        let pool = test_pool().await;
        let me = user(&pool).await;
        let source = native_email(&pool, me.0).await;
        let (_, draft) = create(
            &pool,
            &me,
            json!({ "kind": "reply", "source_email_id": source, "body": SECRET_BODY }),
        )
        .await;
        assert_eq!(draft["source_email_id"], source);

        sqlx::query("DELETE FROM emails WHERE id = $1")
            .bind(source)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("delete: {e}"));

        let (_, listed) = call(&pool, &me, Method::GET, "/email/drafts", None).await;
        assert_eq!(listed[0]["body"], SECRET_BODY);
        assert_eq!(listed[0]["source_email_id"], Value::Null);
    }

    #[actix_web::test]
    async fn refuses_oversized_content_and_too_many_drafts() {
        let pool = test_pool().await;
        let me = user(&pool).await;
        let (status, _) = create(&pool, &me, compose(&"x".repeat(1024 * 1024 + 1))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (iv, sealed) =
            wayve_security::encryption::encrypt("{}").unwrap_or_else(|e| panic!("encrypt: {e}"));
        sqlx::query(
            "INSERT INTO email_drafts (user_id, kind, content_iv, content_encrypted) \
             SELECT $1, 'compose', $2, $3 FROM generate_series(1, 500)",
        )
        .bind(me.0)
        .bind(&iv)
        .bind(&sealed)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("fill: {e}"));
        let (status, _) = create(&pool, &me, compose("one too many")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[actix_web::test]
    async fn requires_a_login() {
        let pool = test_pool().await;
        set_key();
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::email::drafts::list_drafts),
        )
        .await;
        let req = actix_test::TestRequest::get()
            .uri("/email/drafts")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// The policy itself, without the handlers' WHERE clauses behind it.
    #[actix_web::test]
    async fn rls_hides_other_users_rows() {
        let pool = test_pool().await;
        let me = user(&pool).await;
        let other = user(&pool).await;
        let (_, draft) = create(&pool, &me, compose("private")).await;
        let id = id_of(&draft) as i32;

        let visible_to = |uid: Option<i32>| {
            let pool = pool.clone();
            async move {
                let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
                if let Some(uid) = uid {
                    sqlx::query("SELECT set_config('app.user_id', $1, true)")
                        .bind(uid.to_string())
                        .execute(&mut *tx)
                        .await
                        .unwrap_or_else(|e| panic!("guc: {e}"));
                }
                sqlx::query("SET LOCAL ROLE wayve_app")
                    .execute(&mut *tx)
                    .await
                    .unwrap_or_else(|e| panic!("role: {e}"));
                let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM email_drafts WHERE id = $1")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap_or_else(|e| panic!("count: {e}"));
                n
            }
        };
        assert_eq!(visible_to(Some(me.0)).await, 1);
        assert_eq!(visible_to(Some(other.0)).await, 0);
        assert_eq!(visible_to(None).await, 0);
    }
}
