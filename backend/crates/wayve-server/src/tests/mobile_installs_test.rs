// Mobile app install tracking: the app's launch report creates one row per
// install id and refreshes it on later launches, bad reports are refused, new
// ids from one IP are capped per hour, and the stats endpoint is platform-only.
#[cfg(test)]
mod tests {
    use crate::routes::mobile_installs::{mobile_install_stats, report_mobile_install};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use serde_json::json;
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

    async fn cleanup(pool: &PgPool, ip: &str, user_ids: &[i32]) {
        let _ = sqlx::query("DELETE FROM mobile_installs WHERE ip = $1")
            .bind(ip)
            .execute(pool)
            .await;
        for id in user_ids {
            let _ = sqlx::query("DELETE FROM mobile_installs WHERE user_id = $1")
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

    /// A per-run TEST-NET-3 address, so this run's rows are the only ones touched.
    fn test_ip() -> String {
        format!("203.0.113.{}", rand::random::<u8>())
    }

    fn report(install_id: &str, version: &str) -> serde_json::Value {
        json!({
            "install_id": install_id,
            "platform": "ios",
            "channel": "testflight",
            "app_version": version,
            "build": "1",
            "os_version": "18.1",
            "device_model": "iPhone16,2",
        })
    }

    #[actix_web::test]
    async fn launches_create_one_row_per_install_and_refresh_it() {
        let pool = test_pool().await;
        let ip = test_ip();
        cleanup(&pool, &ip, &[]).await;
        let user = insert_local_user(&pool, &random_email(), "password123").await;
        let token = jwt_for(user, "ignored@example.com");
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(report_mobile_install),
        )
        .await;
        let peer = format!("{ip}:4242")
            .parse()
            .unwrap_or_else(|e| panic!("peer addr: {e}"));
        let id = uuid::Uuid::new_v4().to_string();

        // First launch, signed out.
        let req = actix_test::TestRequest::post()
            .uri("/mobile/installs")
            .peer_addr(peer)
            .set_json(report(&id, "1.2.0"))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::NO_CONTENT
        );

        // Second launch after an update, signed in.
        let req = actix_test::TestRequest::post()
            .uri("/mobile/installs")
            .peer_addr(peer)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(report(&id, "1.2.1"))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::NO_CONTENT
        );

        let (count, version, launches, user_id, channel): (
            i64,
            Option<String>,
            i32,
            Option<i32>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT COUNT(*) OVER (), app_version, launches, user_id, channel \
             FROM mobile_installs WHERE install_id = $1",
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("load install: {e}"));
        assert_eq!(count, 1);
        assert_eq!(version.as_deref(), Some("1.2.1"));
        assert_eq!(launches, 2);
        assert_eq!(user_id, Some(user));
        assert_eq!(channel.as_deref(), Some("testflight"));

        // A bad id or an unknown platform is refused.
        for body in [
            json!({ "install_id": "not-a-uuid", "platform": "ios" }),
            json!({ "install_id": uuid::Uuid::new_v4().to_string(), "platform": "symbian" }),
        ] {
            let req = actix_test::TestRequest::post()
                .uri("/mobile/installs")
                .peer_addr(peer)
                .set_json(body)
                .to_request();
            assert_eq!(
                actix_test::call_service(&app, req).await.status(),
                StatusCode::BAD_REQUEST
            );
        }

        cleanup(&pool, &ip, &[user]).await;
    }

    #[actix_web::test]
    async fn new_installs_from_one_ip_are_capped_per_hour() {
        let pool = test_pool().await;
        let ip = test_ip();
        cleanup(&pool, &ip, &[]).await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(report_mobile_install),
        )
        .await;
        let peer = format!("{ip}:4242")
            .parse()
            .unwrap_or_else(|e| panic!("peer addr: {e}"));

        for _ in 0..25 {
            let req = actix_test::TestRequest::post()
                .uri("/mobile/installs")
                .peer_addr(peer)
                .set_json(report(&uuid::Uuid::new_v4().to_string(), "1.2.0"))
                .to_request();
            assert_eq!(
                actix_test::call_service(&app, req).await.status(),
                StatusCode::NO_CONTENT
            );
        }
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mobile_installs WHERE ip = $1")
            .bind(&ip)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("count: {e}"));
        assert_eq!(n, 20);

        cleanup(&pool, &ip, &[]).await;
    }

    #[actix_web::test]
    async fn stats_require_platform_scope_and_count_installs() {
        let pool = test_pool().await;
        let ip = test_ip();
        cleanup(&pool, &ip, &[]).await;
        let personal = insert_local_user(&pool, &random_email(), "password123").await;
        let owner = make_platform_owner(&pool, &random_email()).await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(report_mobile_install)
                .service(mobile_install_stats),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/platform/mobile-installs")
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let personal_token = jwt_for(personal, "ignored@example.com");
        let req = actix_test::TestRequest::get()
            .uri("/platform/mobile-installs")
            .insert_header(("Authorization", format!("Bearer {personal_token}")))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        let owner_token = jwt_for(owner, "ignored@example.com");
        let peer = format!("{ip}:4242")
            .parse()
            .unwrap_or_else(|e| panic!("peer addr: {e}"));
        let req = actix_test::TestRequest::post()
            .uri("/mobile/installs")
            .peer_addr(peer)
            .insert_header(("Authorization", format!("Bearer {owner_token}")))
            .set_json(report(&uuid::Uuid::new_v4().to_string(), "1.2.0"))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::NO_CONTENT
        );

        let req = actix_test::TestRequest::get()
            .uri("/platform/mobile-installs")
            .insert_header(("Authorization", format!("Bearer {owner_token}")))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert!(body["total"].as_i64().unwrap_or_default() >= 1);
        assert!(body["active_30_days"].as_i64().unwrap_or_default() >= 1);
        let ios = body["by_platform"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .find(|b| b["key"] == "ios")
            .and_then(|b| b["count"].as_i64())
            .unwrap_or_default();
        assert!(ios >= 1, "ios count {ios}");
        assert!(body["by_channel"].is_array());
        assert!(body["by_version"].is_array());
        assert!(body["by_location"].is_array());
        let mine = body["recent"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r["user_id"] == owner)
            .count();
        assert_eq!(mine, 1);

        cleanup(&pool, &ip, &[personal, owner]).await;
    }
}
