// Desktop app download tracking: the download link records a row and redirects
// to the S3 installer (anonymous or signed in), an unknown build is a 404 that
// records nothing, and the stats endpoint is platform-scope only.
#[cfg(test)]
mod tests {
    use crate::routes::desktop_downloads::{desktop_download_stats, download_desktop_app};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

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

    async fn cleanup(pool: &PgPool, user_ids: &[i32]) {
        for id in user_ids {
            let _ = sqlx::query("DELETE FROM desktop_downloads WHERE user_id = $1")
                .bind(id)
                .execute(pool)
                .await;
            let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
                .bind(id)
                .execute(pool)
                .await;
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    async fn count_for_user(pool: &PgPool, user_id: i32) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM desktop_downloads WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("count downloads: {e}"))
    }

    #[actix_web::test]
    async fn download_records_and_redirects_to_the_installer() {
        let pool = test_pool().await;
        let user = insert_local_user(&pool, &random_email(), "password123").await;
        let token = jwt_for(user, "ignored@example.com");

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(download_desktop_app),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/desktop/download/mac-arm64")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .insert_header(("User-Agent", "Mozilla/5.0 (Macintosh)"))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FOUND);
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            location.ends_with("/Fluxze-mac-arm64.dmg"),
            "unexpected redirect: {location}"
        );

        let (build, ua): (String, Option<String>) =
            sqlx::query_as("SELECT build, user_agent FROM desktop_downloads WHERE user_id = $1")
                .bind(user)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("load download row: {e}"));
        assert_eq!(build, "mac-arm64");
        assert_eq!(ua.as_deref(), Some("Mozilla/5.0 (Macintosh)"));

        // An unknown build is refused and not counted.
        let req = actix_test::TestRequest::get()
            .uri("/desktop/download/windows")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(count_for_user(&pool, user).await, 1);

        cleanup(&pool, &[user]).await;
    }

    #[actix_web::test]
    async fn anonymous_repeats_from_one_ip_are_recorded_once() {
        let pool = test_pool().await;
        // A per-run address, so this run's rows are the only ones counted and
        // cleaned up (TEST-NET-3, never a real client).
        let ip = format!("203.0.113.{}", rand::random::<u8>());
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(download_desktop_app),
        )
        .await;
        let _ = sqlx::query("DELETE FROM desktop_downloads WHERE ip = $1")
            .bind(&ip)
            .execute(&pool)
            .await;

        let peer = format!("{ip}:4242")
            .parse()
            .unwrap_or_else(|e| panic!("peer addr: {e}"));
        for build in ["mac-x64", "mac-x64", "mac-arm64"] {
            let req = actix_test::TestRequest::get()
                .uri(&format!("/desktop/download/{build}"))
                .peer_addr(peer)
                .to_request();
            // Every click still gets its installer.
            assert_eq!(
                actix_test::call_service(&app, req).await.status(),
                StatusCode::FOUND
            );
        }

        let rows: Vec<(String, Option<i32>)> = sqlx::query_as(
            "SELECT build, user_id FROM desktop_downloads WHERE ip = $1 ORDER BY build",
        )
        .bind(&ip)
        .fetch_all(&pool)
        .await
        .unwrap_or_else(|e| panic!("load rows: {e}"));
        assert_eq!(
            rows,
            vec![
                ("mac-arm64".to_string(), None),
                ("mac-x64".to_string(), None)
            ]
        );

        let _ = sqlx::query("DELETE FROM desktop_downloads WHERE ip = $1")
            .bind(&ip)
            .execute(&pool)
            .await;
    }

    #[actix_web::test]
    async fn stats_require_platform_scope_and_count_downloads() {
        let pool = test_pool().await;
        let personal = insert_local_user(&pool, &random_email(), "password123").await;
        let owner = make_platform_owner(&pool, &random_email()).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(download_desktop_app)
                .service(desktop_download_stats),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/platform/desktop-downloads")
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::UNAUTHORIZED
        );

        let personal_token = jwt_for(personal, "ignored@example.com");
        let req = actix_test::TestRequest::get()
            .uri("/platform/desktop-downloads")
            .insert_header(("Authorization", format!("Bearer {personal_token}")))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        let owner_token = jwt_for(owner, "ignored@example.com");
        for build in ["mac-arm64", "mac-arm64", "mac-x64"] {
            let req = actix_test::TestRequest::get()
                .uri(&format!("/desktop/download/{build}"))
                .insert_header(("Authorization", format!("Bearer {owner_token}")))
                .to_request();
            assert_eq!(
                actix_test::call_service(&app, req).await.status(),
                StatusCode::FOUND
            );
        }

        let req = actix_test::TestRequest::get()
            .uri("/platform/desktop-downloads")
            .insert_header(("Authorization", format!("Bearer {owner_token}")))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;

        assert!(body["total"].as_i64().unwrap_or_default() >= 3);
        let builds = body["by_build"].as_array().cloned().unwrap_or_default();
        let arm = builds
            .iter()
            .find(|b| b["build"] == "mac-arm64")
            .and_then(|b| b["count"].as_i64())
            .unwrap_or_default();
        assert!(arm >= 2, "mac-arm64 count {arm}");
        assert!(body["by_location"].is_array());
        let mine: Vec<_> = body["recent"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r["user_id"] == owner)
            .collect();
        assert_eq!(mine.len(), 3);
        assert!(mine.iter().all(|r| r["user_email"].is_string()));

        cleanup(&pool, &[personal, owner]).await;
    }
}
