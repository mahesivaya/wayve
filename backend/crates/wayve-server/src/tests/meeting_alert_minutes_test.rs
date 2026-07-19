// Meeting alert lead time (users.meeting_alert_minutes): the popup's timing is
// a server-stored preference, so the endpoint has to persist a supported choice
// and refuse an unsupported one rather than clamping it — silently storing a
// different lead time than the user picked would surface as a missed meeting.
#[cfg(test)]
mod tests {
    use crate::email::profile::put_meeting_alert_minutes;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::{PgPool, Row};

    async fn stored_minutes(pool: &PgPool, user_id: i32) -> i16 {
        sqlx::query("SELECT meeting_alert_minutes FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("read meeting_alert_minutes: {e}"))
            .get("meeting_alert_minutes")
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn persists_supported_lead_times_and_rejects_others() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let token = jwt_for(user_id, &email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(put_meeting_alert_minutes)),
        )
        .await;

        // New users start at the 10-minute default.
        assert_eq!(stored_minutes(&pool, user_id).await, 10);

        let put = |minutes: serde_json::Value| {
            actix_test::TestRequest::put()
                .uri("/api/me/meeting-alert-minutes")
                .insert_header(("Authorization", format!("Bearer {token}")))
                .set_json(serde_json::json!({ "minutes": minutes }))
                .to_request()
        };

        // A supported choice persists.
        let resp = actix_test::call_service(&app, put(serde_json::json!(30))).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(stored_minutes(&pool, user_id).await, 30);

        // 0 is the documented "off" value, not a rejection.
        let resp = actix_test::call_service(&app, put(serde_json::json!(0))).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(stored_minutes(&pool, user_id).await, 0);

        // An unsupported number is refused outright, leaving the stored value
        // untouched rather than snapping to a neighbouring choice.
        let resp = actix_test::call_service(&app, put(serde_json::json!(7))).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(stored_minutes(&pool, user_id).await, 0);

        // Out-of-range and non-numeric bodies are refused the same way; neither
        // may reach the column and trip its CHECK constraint.
        for bad in [
            serde_json::json!(-5),
            serde_json::json!(100_000),
            serde_json::json!("15"),
        ] {
            let resp = actix_test::call_service(&app, put(bad)).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }
        assert_eq!(stored_minutes(&pool, user_id).await, 0);
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn rejects_an_unauthenticated_request() {
        let pool = test_pool().await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(put_meeting_alert_minutes)),
        )
        .await;

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::put()
                .uri("/api/me/meeting-alert-minutes")
                .set_json(serde_json::json!({ "minutes": 15 }))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
