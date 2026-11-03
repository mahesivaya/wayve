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
    async fn line_comments_reach_the_diff_endpoints() {
        // Unique repo: the proxy cache is process-wide.
        let suffix = random_email().replace(['@', '.'], "-");
        let repo = format!("acme/lines-{suffix}");
        let sha = "abc1234";

        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/repos/{repo}/pulls/7/comments")))
            .and(body_json(serde_json::json!({
                "body": "Rename this",
                "path": "src/lib.rs",
                "line": 12,
                "side": "RIGHT",
                "commit_id": sha,
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": 1 })))
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/repos/{repo}/commits/{sha}/comments")))
            .and(body_json(serde_json::json!({
                "body": "Why this?",
                "path": "src/lib.rs",
                "position": 4,
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": 2 })))
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
                .service(crate::github_proxy::create_pull_review_comment)
                .service(crate::github_proxy::create_commit_comment),
        )
        .await;
        let bearer = format!("Bearer {}", jwt_for(owner, &email));
        let post = |uri: String, body: serde_json::Value| {
            actix_test::TestRequest::post()
                .uri(&uri)
                .insert_header(("Authorization", bearer.clone()))
                .set_json(body)
                .to_request()
        };
        let pull_uri = format!("/github/repos/{repo}/pulls/7/review-comments");
        let commit_uri = format!("/github/repos/{repo}/commits/{sha}/comments");
        let line = |body: &str, line: i64, side: &str, commit_id: &str| {
            serde_json::json!({
                "body": body,
                "path": "src/lib.rs",
                "line": line,
                "side": side,
                "commit_id": commit_id,
            })
        };

        // Malformed anchors never reach GitHub (its mocks expect exactly one call).
        for bad in [
            line("  ", 12, "RIGHT", sha),
            line("x", 0, "RIGHT", sha),
            line("x", 12, "MIDDLE", sha),
            line("x", 12, "RIGHT", "not/a/sha"),
            serde_json::json!({ "body": "x" }),
        ] {
            let res = actix_test::call_service(&app, post(pull_uri.clone(), bad)).await;
            assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        }
        for bad in [
            serde_json::json!({ "body": "x", "path": "src/lib.rs" }),
            serde_json::json!({ "body": "x", "position": 4 }),
            serde_json::json!({ "body": "x", "path": "src/lib.rs", "position": 0 }),
        ] {
            let res = actix_test::call_service(&app, post(commit_uri.clone(), bad)).await;
            assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        }

        // A valid anchor is forwarded with the body trimmed.
        let res = actix_test::call_service(
            &app,
            post(pull_uri.clone(), line(" Rename this\n", 12, "RIGHT", sha)),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);
        let res = actix_test::call_service(
            &app,
            post(
                commit_uri.clone(),
                serde_json::json!({ "body": "Why this?", "path": "src/lib.rs", "position": 4 }),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);

        cleanup(&pool, owner).await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::remove_var("GITHUB_API_BASE");
            std::env::remove_var("GITHUB_TOKEN");
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn editing_a_comment_takes_its_author_and_an_admin() {
        // Unique repo: the proxy cache is process-wide.
        let suffix = random_email().replace(['@', '.'], "-");
        let repo = format!("acme/edits-{suffix}");

        let mock = MockServer::start().await;
        let by = |login: &str| serde_json::json!({ "id": 1, "user": { "login": login } });
        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "login": "Bot" })),
            )
            .mount(&mock)
            .await;
        // Two comments by the token's account (login case differs, as GitHub
        // allows) and one by somebody else.
        for tail in ["comments/1", "pulls/comments/2"] {
            let upstream = format!("/repos/{repo}/{tail}");
            Mock::given(method("GET"))
                .and(path(upstream.clone()))
                .respond_with(ResponseTemplate::new(200).set_body_json(by("bot")))
                .mount(&mock)
                .await;
            Mock::given(method("PATCH"))
                .and(path(upstream))
                .and(body_json(serde_json::json!({ "body": "Edited" })))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({ "id": 1, "body": "Edited" })),
                )
                .expect(1)
                .mount(&mock)
                .await;
        }
        let theirs = format!("/repos/{repo}/comments/3");
        Mock::given(method("GET"))
            .and(path(theirs.clone()))
            .respond_with(ResponseTemplate::new(200).set_body_json(by("someone-else")))
            .mount(&mock)
            .await;
        Mock::given(method("PATCH"))
            .and(path(theirs))
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
        let owner_email = random_email();
        let owner = make_platform_owner(&pool, &owner_email).await;
        let support_email = random_email();
        let support = make_platform_owner(&pool, &support_email).await;
        sqlx::query("UPDATE platform_members SET role = 'support' WHERE user_id = $1")
            .bind(support)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("set support: {e}"));
        sqlx::query("INSERT INTO member_project_access (user_id, repo_full_name) VALUES ($1, $2)")
            .bind(support)
            .bind(&repo)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("seed repo grant: {e}"));
        // Removed again below only if this test is what added it.
        let seeded_access = sqlx::query_scalar::<_, String>(
            "INSERT INTO platform_feature_access (feature_key, role) VALUES ('code_repo', 'support') \
             ON CONFLICT DO NOTHING RETURNING role",
        )
        .fetch_optional(&pool)
        .await
        .unwrap_or_else(|e| panic!("seed feature access: {e}"))
        .is_some();

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::github_proxy::edit_commit_comment)
                .service(crate::github_proxy::edit_pull_review_comment),
        )
        .await;
        let admin = format!("Bearer {}", jwt_for(owner, &owner_email));
        let member = format!("Bearer {}", jwt_for(support, &support_email));
        let edit = |bearer: &str, tail: &str, body: serde_json::Value| {
            actix_test::TestRequest::patch()
                .uri(&format!("/github/repos/{repo}/{tail}"))
                .insert_header(("Authorization", bearer.to_string()))
                .set_json(body)
                .to_request()
        };
        let edited = serde_json::json!({ "body": " Edited\n" });

        // A blank edit is refused.
        let res = actix_test::call_service(
            &app,
            edit(&admin, "comments/1", serde_json::json!({ "body": " " })),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        // A non-admin can't edit through the shared token, even its own account's.
        let res = actix_test::call_service(&app, edit(&member, "comments/1", edited.clone())).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let refusal: serde_json::Value = actix_test::read_body_json(res).await;
        assert_eq!(
            refusal["message"],
            "Only a project admin can edit comments here"
        );

        // Somebody else's comment stays theirs, even for the owner.
        let res = actix_test::call_service(&app, edit(&admin, "comments/3", edited.clone())).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let refusal: serde_json::Value = actix_test::read_body_json(res).await;
        assert_eq!(refusal["message"], "You can only edit your own comments");

        // The admin edits the account's comments, on both kinds, trimmed.
        for tail in ["comments/1", "pulls/comments/2"] {
            let res = actix_test::call_service(&app, edit(&admin, tail, edited.clone())).await;
            assert_eq!(res.status(), StatusCode::OK, "{tail}");
        }

        if seeded_access {
            let _ = sqlx::query(
                "DELETE FROM platform_feature_access \
                 WHERE feature_key = 'code_repo' AND role = 'support'",
            )
            .execute(&pool)
            .await;
        }
        let _ = sqlx::query("DELETE FROM member_project_access WHERE user_id = $1")
            .bind(support)
            .execute(&pool)
            .await;
        cleanup(&pool, support).await;
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
