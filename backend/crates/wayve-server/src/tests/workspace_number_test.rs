// Story and ticket numbers are a per-owner MAX(number)+1 sequence. Concurrent
// creates for one owner must still get distinct numbers: the insert takes the
// owner's advisory lock first (tasks::statuses::lock_owner_sequence), and a
// partial unique index per owner backs that up.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use crate::tickets::handler::create_ticket;
    use crate::user_stories::handler::create_user_story;
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use futures::future::join_all;

    const CONCURRENT: usize = 12;

    /// Fires CONCURRENT creates at `uri` for one fresh personal user and returns
    /// the numbers they were given, sorted.
    async fn concurrent_numbers(uri: &str, number_field: &str) -> Vec<i64> {
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

        let responses = join_all((0..CONCURRENT).map(|i| {
            let req = actix_test::TestRequest::post()
                .uri(uri)
                .insert_header(("Authorization", format!("Bearer {token}")))
                .set_json(serde_json::json!({ "name": format!("item {i}") }))
                .to_request();
            actix_test::call_service(&app, req)
        }))
        .await;

        let mut numbers = Vec::with_capacity(CONCURRENT);
        for resp in responses {
            assert_eq!(resp.status(), StatusCode::OK, "create {uri}");
            let body: serde_json::Value = actix_test::read_body_json(resp).await;
            let number = body[number_field]
                .as_i64()
                .unwrap_or_else(|| panic!("{number_field} missing in {body}"));
            numbers.push(number);
        }
        numbers.sort_unstable();
        numbers
    }

    fn one_to_n() -> Vec<i64> {
        (1..=CONCURRENT as i64).collect()
    }

    #[actix_web::test]
    async fn concurrent_stories_get_distinct_numbers() {
        assert_eq!(
            concurrent_numbers("/user-stories", "task_number").await,
            one_to_n()
        );
    }

    #[actix_web::test]
    async fn concurrent_tickets_get_distinct_numbers() {
        assert_eq!(
            concurrent_numbers("/workspace-tickets", "task_number").await,
            one_to_n()
        );
    }
}
