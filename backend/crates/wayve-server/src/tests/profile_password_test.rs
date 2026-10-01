// Creating vs changing a password from the profile page. A Google signup has no
// password, so its first one is created without a current password; once one
// exists, changing it needs the current one, even though `auth_provider` stays
// "google". `/api/profile` reports `has_password` so the form can show the right
// fields, and it must reflect a just-created password straight away (the
// profile response is cached).
#[cfg(test)]
mod tests {
    use crate::routes::user::{change_password, get_profile};
    use crate::test_support::{
        insert_google_user, insert_local_user, jwt_for, random_email, test_pool,
    };
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use serde_json::{Value, json};

    macro_rules! app {
        ($pool:expr) => {
            actix_test::init_service(
                App::new()
                    .app_data(web::Data::new($pool.clone()))
                    .service(get_profile)
                    .service(change_password),
            )
            .await
        };
    }

    fn bearer(id: i32, email: &str) -> (&'static str, String) {
        ("Authorization", format!("Bearer {}", jwt_for(id, email)))
    }

    #[actix_web::test]
    async fn google_user_creates_then_must_confirm_to_change() {
        let pool = test_pool().await;
        let app = app!(pool);
        let email = random_email();
        let id = insert_google_user(&pool, &email).await;

        let get = || {
            actix_test::TestRequest::get()
                .uri("/profile")
                .insert_header(bearer(id, &email))
                .to_request()
        };
        let body: Value = actix_test::call_and_read_body_json(&app, get()).await;
        assert_eq!(body["auth_provider"], "google");
        assert_eq!(
            body["has_password"], false,
            "a Google signup starts without one"
        );

        // Creating: no current password.
        let req = actix_test::TestRequest::post()
            .uri("/profile/password")
            .insert_header(bearer(id, &email))
            .set_json(json!({ "current_password": null, "new_password": "first-pass-1" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: Value = actix_test::read_body_json(resp).await;
        assert_eq!(body["message"], "Password created");

        // The cached profile now says so, and the provider is unchanged.
        let body: Value = actix_test::call_and_read_body_json(&app, get()).await;
        assert_eq!(body["has_password"], true);
        assert_eq!(body["auth_provider"], "google");

        // Changing it now requires the current password.
        let req = actix_test::TestRequest::post()
            .uri("/profile/password")
            .insert_header(bearer(id, &email))
            .set_json(json!({ "current_password": null, "new_password": "second-pass-2" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::UNAUTHORIZED,
            "an existing password can't be replaced without it"
        );
        let req = actix_test::TestRequest::post()
            .uri("/profile/password")
            .insert_header(bearer(id, &email))
            .set_json(
                json!({ "current_password": "first-pass-1", "new_password": "second-pass-2" }),
            )
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: Value = actix_test::read_body_json(resp).await;
        assert_eq!(body["message"], "Password updated");
    }

    #[actix_web::test]
    async fn password_signup_reports_has_password() {
        let pool = test_pool().await;
        let app = app!(pool);
        let email = random_email();
        let id = insert_local_user(&pool, &email, "password123").await;

        let req = actix_test::TestRequest::get()
            .uri("/profile")
            .insert_header(bearer(id, &email))
            .to_request();
        let body: Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(body["has_password"], true);
    }
}
