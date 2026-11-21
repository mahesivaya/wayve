// The GitHub App's webhook (`POST /github-app/webhook`): refused without the
// secret or with a bad signature; pull request activity goes only to members
// who can see the repo; an uninstall on GitHub forgets the installation.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use sqlx::PgPool;

    const SECRET: &str = "webhook-test-secret";

    fn sign(body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes())
            .unwrap_or_else(|e| panic!("hmac: {e}"));
        mac.update(body);
        let bytes = mac.finalize().into_bytes();
        format!(
            "sha256={}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )
    }

    async fn insert_org(pool: &PgPool, name: &str) -> i32 {
        sqlx::query_scalar::<_, i32>("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"))
    }

    async fn org_user(pool: &PgPool, org_id: i32, role: &str) -> i32 {
        let id = insert_local_user(pool, &random_email(), "password123").await;
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)",
        )
        .bind(org_id)
        .bind(id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("member: {e}"));
        id
    }

    async fn exec(pool: &PgPool, sql: &str, org_id: i32, text: &str) {
        sqlx::query(sql)
            .bind(org_id)
            .bind(text)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn webhook_is_signed_reaches_the_right_members_and_handles_uninstall() {
        let pool = test_pool().await;
        let suffix = rand::random::<u32>();
        let repo = format!("acme{suffix}/api");
        let installation_id: i64 = 8_000_000 + i64::from(rand::random::<u16>());

        let org = insert_org(&pool, &format!("Webhook {suffix}")).await;
        let owner = org_user(&pool, org, "owner").await;
        let granted = org_user(&pool, org, "member").await;
        let plain = org_user(&pool, org, "member").await;
        let (gh_owner, gh_repo) = repo.split_once('/').unwrap_or_default();
        sqlx::query(
            "INSERT INTO projects (organization_id, name, github_owner, github_repo) VALUES ($1, 'api', $2, $3)",
        )
        .bind(org)
        .bind(gh_owner)
        .bind(gh_repo)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("project: {e}"));
        sqlx::query("INSERT INTO member_project_access (user_id, repo_full_name) VALUES ($1, $2)")
            .bind(granted)
            .bind(&repo)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("grant: {e}"));
        exec(
            &pool,
            "INSERT INTO github_installations (organization_id, installation_id, account_login)
             VALUES ($1, $2::text::bigint, 'acme')",
            org,
            &installation_id.to_string(),
        )
        .await;

        // Only the owner and the member granted the repo hear about it.
        let mut to = crate::github_app_webhook::recipients(&pool, org, &repo.to_uppercase())
            .await
            .unwrap_or_else(|e| panic!("recipients: {e}"));
        to.sort_unstable();
        let mut expected = vec![owner, granted];
        expected.sort_unstable();
        assert_eq!(to, expected);
        assert!(!to.contains(&plain));
        // Nobody, for a repo the organization never added.
        let none = crate::github_app_webhook::recipients(&pool, org, "acme/other")
            .await
            .unwrap_or_else(|e| panic!("recipients: {e}"));
        assert!(none.is_empty());

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<crate::cache::Cache>))
                .service(crate::github_app_webhook::github_app_webhook),
        )
        .await;
        let deliver = |event: &'static str, body: serde_json::Value, signed: bool| {
            let app = &app;
            async move {
                let bytes = body.to_string().into_bytes();
                let mut req = actix_test::TestRequest::post()
                    .uri("/github-app/webhook")
                    .insert_header(("X-GitHub-Event", event))
                    .insert_header(("Content-Type", "application/json"));
                if signed {
                    req = req.insert_header(("X-Hub-Signature-256", sign(&bytes)));
                }
                actix_test::call_service(app, req.set_payload(bytes).to_request())
                    .await
                    .status()
            }
        };
        let pull = serde_json::json!({
            "action": "opened",
            "installation": { "id": installation_id },
            "repository": { "full_name": repo },
            "pull_request": { "number": 7 }
        });

        // No secret configured: refused, not trusted.
        // SAFETY: serialized via #[serial].
        unsafe { std::env::remove_var("GITHUB_APP_WEBHOOK_SECRET") };
        assert_eq!(
            deliver("pull_request", pull.clone(), true).await,
            StatusCode::SERVICE_UNAVAILABLE
        );

        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GITHUB_APP_WEBHOOK_SECRET", SECRET) };
        assert_eq!(
            deliver("pull_request", pull.clone(), false).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            deliver("pull_request", pull.clone(), true).await,
            StatusCode::OK
        );

        // Uninstalled on GitHub: the connection is forgotten.
        let uninstall = serde_json::json!({
            "action": "deleted",
            "installation": { "id": installation_id }
        });
        assert_eq!(
            deliver("installation", uninstall, true).await,
            StatusCode::OK
        );
        let left = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM github_installations WHERE organization_id = $1",
        )
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("count: {e}"));
        assert_eq!(left, 0);

        // SAFETY: serialized via #[serial].
        unsafe { std::env::remove_var("GITHUB_APP_WEBHOOK_SECRET") };
        for id in [owner, granted, plain] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(&pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org)
            .execute(&pool)
            .await;
    }
}
