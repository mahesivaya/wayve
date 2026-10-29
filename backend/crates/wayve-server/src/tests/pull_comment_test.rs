// Posting a pull request conversation comment through the GitHub proxy, against
// a mocked GitHub (wiremock via GITHUB_API_BASE). The comment goes to the PR's
// issue comments; the cached conversation is dropped so the page's refetch
// shows it; an empty body is refused; a platform owner outside admin mode is a
// member AND an owner in the DB, so the repo gate still admits them. And
// an org member who has access to the repo (Code Repo enabled for members plus
// a repo grant) can read and comment on PRs but not approve them.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, jwt_for_mode, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn make_platform_owner(pool: &PgPool, email: &str) -> i32 {
        let id = insert_local_user(pool, email, "password123").await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, 'owner') \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set platform owner: {e}"));
        id
    }

    async fn cleanup(pool: &PgPool, user_id: i32) {
        for sql in [
            "DELETE FROM platform_members WHERE user_id = $1",
            "DELETE FROM users WHERE id = $1",
        ] {
            let _ = sqlx::query(sql).bind(user_id).execute(pool).await;
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn platform_owner_comments_on_a_pull_request() {
        // Unique repo: the proxy cache is process-wide.
        let suffix = random_email().replace(['@', '.'], "-");
        let repo = format!("acme/comments-{suffix}");
        let comments_path = format!("/repos/{repo}/issues/7/comments");

        let mock = MockServer::start().await;
        let before =
            serde_json::json!([{ "id": 1, "body": "earlier", "user": { "login": "dev" } }]);
        let after = serde_json::json!([
            { "id": 1, "body": "earlier", "user": { "login": "dev" } },
            { "id": 2, "body": "Looks good", "user": { "login": "bot" } }
        ]);
        // The conversation as read before the post (served once), then after.
        Mock::given(method("GET"))
            .and(path(comments_path.clone()))
            .respond_with(ResponseTemplate::new(200).set_body_json(before))
            .up_to_n_times(1)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path(comments_path.clone()))
            .respond_with(ResponseTemplate::new(200).set_body_json(after))
            .mount(&mock)
            .await;
        // The body is trimmed before it is sent.
        Mock::given(method("POST"))
            .and(path(comments_path.clone()))
            .and(body_json(serde_json::json!({ "body": "Looks good" })))
            .respond_with(
                ResponseTemplate::new(201)
                    .set_body_json(serde_json::json!({ "id": 2, "body": "Looks good" })),
            )
            .expect(1)
            .mount(&mock)
            .await;

        // SAFETY: serialized via #[serial]; points GitHub calls at the mock.
        unsafe {
            std::env::set_var("GITHUB_API_BASE", mock.uri());
            std::env::set_var("GITHUB_TOKEN", "ghp_shared_server_token");
        }

        let pool = test_pool().await;
        let email = random_email();
        let owner = make_platform_owner(&pool, &email).await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::github_proxy::create_pull_comment)
                .service(crate::github_proxy::github_proxy),
        )
        .await;
        let admin = format!("Bearer {}", jwt_for(owner, &email));
        let normal = format!(
            "Bearer {}",
            jwt_for_mode(owner, &email, wayve_security::jwt::SessionMode::Normal)
        );
        let read_conversation = || {
            actix_test::TestRequest::get()
                .uri(&format!("/github{comments_path}?per_page=100"))
                .insert_header(("Authorization", admin.clone()))
                .to_request()
        };
        let post = |bearer: &str, body: serde_json::Value| {
            actix_test::TestRequest::post()
                .uri(&format!("/github/repos/{repo}/pulls/7/comments"))
                .insert_header(("Authorization", bearer.to_string()))
                .set_json(body)
                .to_request()
        };

        // Read (and cache) the conversation as it stands.
        let first: serde_json::Value =
            actix_test::call_and_read_body_json(&app, read_conversation()).await;
        assert_eq!(first.as_array().map(Vec::len), Some(1), "{first}");

        // An empty comment never reaches GitHub.
        let res =
            actix_test::call_service(&app, post(&admin, serde_json::json!({ "body": "  " }))).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        // Outside admin mode the owner is a member, but still an owner in the
        // DB, so the repo gate admits them and the comment posts, trimmed.
        let res = actix_test::call_service(
            &app,
            post(&normal, serde_json::json!({ "body": "  Looks good \n" })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);

        // The refetch sees the new comment, not the cached copy.
        let second: serde_json::Value =
            actix_test::call_and_read_body_json(&app, read_conversation()).await;
        assert_eq!(second.as_array().map(Vec::len), Some(2), "{second}");

        cleanup(&pool, owner).await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
            std::env::remove_var("GITHUB_TOKEN");
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn member_with_repo_access_comments_but_cannot_approve() {
        let suffix = random_email().replace(['@', '.'], "-");
        let (gh_owner, gh_repo) = ("acme", format!("member-{suffix}"));
        let full = format!("{gh_owner}/{gh_repo}");

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/repos/{full}/pulls/7")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "number": 7 })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/repos/{full}/issues/7/comments")))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": 3 })))
            .expect(1)
            .mount(&mock)
            .await;
        // Approving must be refused before anything reaches GitHub.
        Mock::given(method("POST"))
            .and(path(format!("/repos/{full}/pulls/7/reviews")))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&mock)
            .await;

        // SAFETY: serialized via #[serial]; points GitHub calls at the mock.
        unsafe {
            std::env::set_var("GITHUB_API_BASE", mock.uri());
            std::env::set_var("GITHUB_TOKEN", "ghp_shared_server_token");
        }

        let pool = test_pool().await;
        let org_id = sqlx::query_scalar::<_, i32>(
            "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
        )
        .bind(format!("PR Org {suffix}"))
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert org: {e}"));
        let email = random_email();
        let member = insert_local_user(&pool, &email, "password123").await;
        for (sql, what) in [
            (
                "UPDATE users SET account_type = 'organization', organization_id = $1 WHERE id = $2",
                "attach user",
            ),
            (
                "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')",
                "set role",
            ),
        ] {
            sqlx::query(sql)
                .bind(org_id)
                .bind(member)
                .execute(&pool)
                .await
                .unwrap_or_else(|e| panic!("{what}: {e}"));
        }
        // The repo is linked to the org, Code Repo is enabled for members, and
        // this member holds a grant for the repo: the access a member needs.
        sqlx::query(
            "INSERT INTO projects (name, organization_id, github_owner, github_repo)
             VALUES ('P', $1, $2, $3)",
        )
        .bind(org_id)
        .bind(gh_owner)
        .bind(&gh_repo)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert project: {e}"));
        sqlx::query(
            "INSERT INTO organization_feature_access (organization_id, feature_key, role)
             VALUES ($1, 'code_repo', 'member')",
        )
        .bind(org_id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("seed feature access: {e}"));
        sqlx::query("INSERT INTO member_project_access (user_id, repo_full_name) VALUES ($1, $2)")
            .bind(member)
            .bind(&full)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("seed repo grant: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::github_proxy::create_pull_comment)
                .service(crate::github_proxy::approve_pull_request)
                .service(crate::github_proxy::github_proxy),
        )
        .await;
        let bearer = format!("Bearer {}", jwt_for(member, &email));

        // Members may read the PR...
        let req = actix_test::TestRequest::get()
            .uri(&format!("/github/repos/{full}/pulls/7"))
            .insert_header(("Authorization", bearer.clone()))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );

        // ...and comment on it...
        let req = actix_test::TestRequest::post()
            .uri(&format!("/github/repos/{full}/pulls/7/comments"))
            .insert_header(("Authorization", bearer.clone()))
            .set_json(serde_json::json!({ "body": "From a member" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::CREATED
        );

        // ...but approving stays owner-only.
        let req = actix_test::TestRequest::post()
            .uri(&format!("/github/repos/{full}/pulls/7/approve"))
            .insert_header(("Authorization", bearer))
            .set_json(serde_json::json!({}))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        let _ = sqlx::query("DELETE FROM member_project_access WHERE user_id = $1")
            .bind(member)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(member)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(&pool)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
            std::env::remove_var("GITHUB_TOKEN");
        }
    }
}
