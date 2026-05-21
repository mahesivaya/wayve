#[cfg(test)]
mod tests {
    use crate::routes::user::{
        change_password, current_plan_for_user, get_profile, update_profile,
    };
    use crate::test_support::{
        delete_user, insert_google_user, insert_local_user, jwt_for, random_email, test_pool,
    };
    use actix_web::{App, http::StatusCode, test, web};
    use bcrypt::verify;
    use serde_json::json;

    #[actix_web::test]
    async fn get_profile_requires_auth() {
        let pool = test_pool().await;
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_profile),
        )
        .await;

        let req = test::TestRequest::get().uri("/profile").to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn get_profile_returns_user_with_provider() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "p").await;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_profile),
        )
        .await;

        let req = test::TestRequest::get()
            .uri("/profile")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(body["email"], email);
        assert_eq!(body["auth_provider"], "local");

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn update_profile_persists_names() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "p").await;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(update_profile),
        )
        .await;

        let req = test::TestRequest::put()
            .uri("/profile")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(json!({ "first_name": "Ada", "last_name": "Lovelace" }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(body["first_name"], "Ada");
        assert_eq!(body["last_name"], "Lovelace");

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn update_profile_preserves_omitted_fields() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "p").await;

        sqlx::query("UPDATE users SET first_name = $1, last_name = $2 WHERE id = $3")
            .bind("Ada")
            .bind("Lovelace")
            .bind(user_id)
            .execute(&pool)
            .await
            .unwrap();

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(update_profile),
        )
        .await;

        let req = test::TestRequest::put()
            .uri("/profile")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(json!({ "first_name": "Augusta" }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(body["first_name"], "Augusta");
        assert_eq!(body["last_name"], "Lovelace");

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn change_password_succeeds_for_local_user() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "current-pw").await;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(change_password),
        )
        .await;

        let req = test::TestRequest::post()
            .uri("/profile/password")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(json!({
                "current_password": "current-pw",
                "new_password": "fresh-pw-123",
            }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The new password must verify against the stored hash.
        let row = sqlx::query("SELECT password FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let stored: Option<String> = sqlx::Row::try_get(&row, "password").unwrap_or(None);
        let stored = stored.expect("password set");
        assert!(verify("fresh-pw-123", &stored).unwrap());

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn change_password_rejects_wrong_current() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "real-pw").await;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(change_password),
        )
        .await;

        let req = test::TestRequest::post()
            .uri("/profile/password")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(json!({
                "current_password": "WRONG",
                "new_password": "doesntmatter",
            }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn change_password_rejects_short_new_password() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "current").await;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(change_password),
        )
        .await;

        let req = test::TestRequest::post()
            .uri("/profile/password")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(json!({
                "current_password": "current",
                "new_password": "x",
            }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn change_password_creates_password_for_google_user() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_google_user(&pool, &email).await;

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(change_password),
        )
        .await;

        let req = test::TestRequest::post()
            .uri("/profile/password")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .set_json(json!({
                "new_password": "fresh-pw-123",
            }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let row = sqlx::query("SELECT password FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let stored: Option<String> = sqlx::Row::try_get(&row, "password").unwrap_or(None);
        let stored = stored.expect("password set");
        assert!(verify("fresh-pw-123", &stored).unwrap());

        delete_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn change_password_requires_auth() {
        let pool = test_pool().await;
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(change_password),
        )
        .await;

        let req = test::TestRequest::post()
            .uri("/profile/password")
            .set_json(json!({
                "current_password": "x",
                "new_password": "fresh-pw-123",
            }))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn current_plan_falls_back_to_basic_user_without_subscription() {
        let pool = test_pool().await;
        sqlx::query(
            r#"
            INSERT INTO plans
                (code, name, description, audience, amount_cents,
                 billing_interval, storage_limit_bytes, seat_limit, features)
            VALUES
                ('basic_user', 'Basic User', 'Free personal plan',
                 'personal', 0, 'month', 1073741824, 1, '{}'::jsonb)
            ON CONFLICT (code) DO NOTHING
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password").await;

        let plan = current_plan_for_user(&pool, user_id, None).await.unwrap();
        assert_eq!(plan.code, "basic_user");
        assert_eq!(plan.audience, "personal");
        assert_eq!(plan.amount_cents, 0);

        delete_user(&pool, user_id).await;
    }
}
