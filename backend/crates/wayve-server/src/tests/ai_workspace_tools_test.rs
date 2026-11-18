// The assistant's workspace tools (ai/workspace_tools.rs): listing the caller's
// user stories and tickets, and proposing a status change. A proposal must
// never write; the browser makes the change once the user confirms.
#[cfg(test)]
mod tests {
    use crate::ai::agent::PendingAction;
    use crate::ai::native_tools::dispatch;
    use crate::ai::provider::DataAccess;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use crate::tickets::handler::create_ticket;
    use crate::user_stories::handler::create_user_story;
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use serde_json::{Value, json};
    use sqlx::PgPool;

    /// A fresh personal user with `names` created through the real endpoint, so
    /// numbers and the default status are whatever the board would give them.
    async fn user_with(uri: &str, names: &[&str]) -> (PgPool, i32) {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password123").await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_user_story)
                .service(create_ticket),
        )
        .await;
        let token = jwt_for(user_id, &email);
        for name in names {
            let req = actix_test::TestRequest::post()
                .uri(uri)
                .insert_header(("Authorization", format!("Bearer {token}")))
                .set_json(json!({ "name": name }))
                .to_request();
            let resp = actix_test::call_service(&app, req).await;
            assert_eq!(resp.status(), StatusCode::OK, "create {uri}");
        }
        (pool, user_id)
    }

    async fn call(
        pool: &PgPool,
        user_id: i32,
        tool: &str,
        args: Value,
    ) -> (Value, Option<PendingAction>) {
        let (_, value, pending) = dispatch(pool, user_id, tool, &args, DataAccess::default())
            .await
            .unwrap_or_else(|| panic!("{tool} is not a native tool"));
        (value, pending)
    }

    fn names(listing: &Value) -> Vec<String> {
        listing["items"]
            .as_array()
            .unwrap_or_else(|| panic!("no items in {listing}"))
            .iter()
            .map(|i| i["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    async fn story_status(pool: &PgPool, user_id: i32, name: &str) -> String {
        sqlx::query_scalar("SELECT status FROM user_stories WHERE user_id = $1 AND name = $2")
            .bind(user_id)
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("story {name}: {e}"))
    }

    #[actix_web::test]
    async fn lists_the_callers_stories_with_keys_and_statuses() {
        let (pool, user_id) = user_with("/user-stories", &["Login page", "Checkout flow"]).await;
        let (listing, pending) = call(&pool, user_id, "wayve_list_user_stories", json!({})).await;

        assert!(pending.is_none());
        assert_eq!(listing["total"], 2);
        assert_eq!(names(&listing), ["Login page", "Checkout flow"]);
        // No project, so the board's no-project key.
        assert_eq!(listing["items"][0]["key"], "NON001");
        assert_eq!(listing["items"][1]["key"], "NON002");
        let statuses = listing["statuses"]
            .as_array()
            .unwrap_or_else(|| panic!("no statuses in {listing}"));
        assert!(!statuses.is_empty());
        // The status is the name people see, not the slug.
        assert_eq!(listing["items"][0]["status"], statuses[0]);
    }

    #[actix_web::test]
    async fn never_lists_another_users_stories() {
        let (pool, _owner) = user_with("/user-stories", &["Private story"]).await;
        let other = insert_local_user(&pool, &random_email(), "password123").await;
        let (listing, _) = call(&pool, other, "wayve_list_user_stories", json!({})).await;
        assert_eq!(listing["total"], 0);

        // ...and cannot propose a change to one either.
        let (result, pending) = call(
            &pool,
            other,
            "wayve_set_user_story_status",
            json!({ "story": "Private story", "status": "Completed" }),
        )
        .await;
        assert_eq!(result["isError"], true);
        assert!(pending.is_none());
    }

    #[actix_web::test]
    async fn proposing_a_status_change_does_not_write() {
        let (pool, user_id) = user_with("/user-stories", &["Login page", "Checkout flow"]).await;
        let before = story_status(&pool, user_id, "Checkout flow").await;

        let (listing, _) = call(&pool, user_id, "wayve_list_user_stories", json!({})).await;
        // Any status other than the one the story is born in.
        let target = listing["statuses"]
            .as_array()
            .and_then(|s| s.last())
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("no statuses in {listing}"))
            .to_string();

        let (result, pending) = call(
            &pool,
            user_id,
            "wayve_set_user_story_status",
            json!({ "story": "non002", "status": target.to_uppercase() }),
        )
        .await;

        assert_eq!(result["status"], "awaiting_confirmation");
        match pending {
            Some(PendingAction::SetStatus {
                kind,
                key,
                name,
                to_status_name,
                ..
            }) => {
                assert_eq!(kind, "user_story");
                assert_eq!(key.as_deref(), Some("NON002"));
                assert_eq!(name, "Checkout flow");
                assert_eq!(to_status_name, target);
            }
            _ => panic!("expected a pending status change, got {result}"),
        }
        // Still where it was: only the user's confirmation moves it.
        assert_eq!(story_status(&pool, user_id, "Checkout flow").await, before);
    }

    #[actix_web::test]
    async fn refuses_an_unknown_status_or_story_and_names_the_valid_statuses() {
        let (pool, user_id) = user_with("/user-stories", &["Login page"]).await;

        let (result, pending) = call(
            &pool,
            user_id,
            "wayve_set_user_story_status",
            json!({ "story": "NON001", "status": "Shipped to the moon" }),
        )
        .await;
        assert_eq!(result["isError"], true);
        assert!(pending.is_none());
        assert!(
            result["error"]
                .as_str()
                .is_some_and(|e| e.contains("The statuses are"))
        );

        let (result, pending) = call(
            &pool,
            user_id,
            "wayve_set_user_story_status",
            json!({ "story": "NON099", "status": "Completed" }),
        )
        .await;
        assert_eq!(result["isError"], true);
        assert!(pending.is_none());
    }

    #[actix_web::test]
    async fn moving_to_the_current_status_is_a_no_op() {
        let (pool, user_id) = user_with("/user-stories", &["Login page"]).await;
        let (listing, _) = call(&pool, user_id, "wayve_list_user_stories", json!({})).await;
        let current = listing["items"][0]["status"].clone();

        let (result, pending) = call(
            &pool,
            user_id,
            "wayve_set_user_story_status",
            json!({ "story": "Login page", "status": current }),
        )
        .await;
        assert_eq!(result["status"], "unchanged");
        assert!(pending.is_none());
    }

    #[actix_web::test]
    async fn tickets_have_the_same_tools() {
        let (pool, user_id) = user_with("/workspace-tickets", &["Broken upload"]).await;
        let (listing, _) = call(&pool, user_id, "wayve_list_tickets", json!({})).await;
        assert_eq!(names(&listing), ["Broken upload"]);
        assert_eq!(listing["items"][0]["key"], "#1");

        let target = listing["statuses"]
            .as_array()
            .and_then(|s| s.last())
            .cloned()
            .unwrap_or_else(|| panic!("no statuses in {listing}"));
        let (result, pending) = call(
            &pool,
            user_id,
            "wayve_set_ticket_status",
            json!({ "ticket": "#1", "status": target }),
        )
        .await;
        assert_eq!(result["status"], "awaiting_confirmation");
        assert!(matches!(
            pending,
            Some(PendingAction::SetStatus { kind, .. }) if kind == "ticket"
        ));
    }
}
