// The Reviewer on a user story or ticket: set at creation or by an update,
// cleared by sending "", and left alone by an update that doesn't mention it
// (an older client saving a status change must not wipe the reviewer).
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use crate::tickets::handler::{create_ticket, update_ticket};
    use crate::user_stories::handler::{create_user_story, update_user_story};
    use actix_web::{App, test as actix_test, web};
    use serde_json::{Value, json};

    async fn reviewer_round_trip(collection: &str) {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let reviewer_email = random_email();
        let reviewer_id = insert_local_user(&pool, &reviewer_email, "password123").await;
        let auth = format!("Bearer {}", jwt_for(user_id, &email));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_user_story)
                .service(update_user_story)
                .service(create_ticket)
                .service(update_ticket),
        )
        .await;

        // Created with a reviewer.
        let req = actix_test::TestRequest::post()
            .uri(&format!("/{collection}"))
            .insert_header(("Authorization", auth.clone()))
            .set_json(json!({
                "name": "Needs a second pair of eyes",
                "reviewer": reviewer_email,
                "reviewer_id": reviewer_id,
            }))
            .to_request();
        let created: Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(
            created["reviewer"],
            json!(reviewer_email),
            "{collection} create"
        );
        assert_eq!(
            created["reviewer_id"],
            json!(reviewer_id),
            "{collection} create"
        );
        let id = created["id"]
            .as_i64()
            .unwrap_or_else(|| panic!("id missing in {created}"));

        let update = |body: Value| {
            actix_test::TestRequest::put()
                .uri(&format!("/{collection}/{id}"))
                .insert_header(("Authorization", auth.clone()))
                .set_json(body)
                .to_request()
        };

        // An update that doesn't mention the reviewer keeps it.
        let kept: Value = actix_test::call_and_read_body_json(
            &app,
            update(json!({ "name": "Renamed", "priority": 2 })),
        )
        .await;
        assert_eq!(kept["name"], json!("Renamed"));
        assert_eq!(
            kept["reviewer"],
            json!(reviewer_email),
            "{collection} keeps"
        );
        assert_eq!(
            kept["reviewer_id"],
            json!(reviewer_id),
            "{collection} keeps"
        );

        // Sending "" clears both the address and the linked user.
        let cleared: Value = actix_test::call_and_read_body_json(
            &app,
            update(json!({ "name": "Renamed", "reviewer": "", "reviewer_id": null })),
        )
        .await;
        assert_eq!(cleared["reviewer"], json!(""), "{collection} clears");
        assert!(cleared["reviewer_id"].is_null(), "{collection} clears");

        // And it can be set again by an update.
        let set: Value = actix_test::call_and_read_body_json(
            &app,
            update(json!({
                "name": "Renamed",
                "reviewer": format!("  {reviewer_email} "),
                "reviewer_id": reviewer_id,
            })),
        )
        .await;
        assert_eq!(set["reviewer"], json!(reviewer_email), "{collection} sets");
        assert_eq!(set["reviewer_id"], json!(reviewer_id), "{collection} sets");
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_story_keeps_clears_and_sets_its_reviewer() {
        reviewer_round_trip("user-stories").await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_ticket_keeps_clears_and_sets_its_reviewer() {
        reviewer_round_trip("workspace-tickets").await;
    }
}
