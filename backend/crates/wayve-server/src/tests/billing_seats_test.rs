//! Organization plans bill per user: the Stripe quantity follows the org's user
//! count, a repeat sync writes nothing, and deprovisioned users aren't billed.

#[cfg(test)]
mod tests {
    use crate::billing::seats::{billable_seats, reconcile_org_seats, sync_org_seats};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::PgPool;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn org_with_users(pool: &PgPool, users: usize) -> i32 {
        let org_id: i32 =
            sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
                .bind(format!("Seats {}", random_email()))
                .fetch_one(pool)
                .await
                .unwrap_or_else(|e| panic!("insert org: {e}"));
        for _ in 0..users {
            let user_id = insert_local_user(pool, &random_email(), "pw").await;
            sqlx::query("UPDATE users SET organization_id = $1, account_type = 'organization' WHERE id = $2")
                .bind(org_id)
                .bind(user_id)
                .execute(pool)
                .await
                .unwrap_or_else(|e| panic!("add user: {e}"));
        }
        org_id
    }

    async fn subscribe(pool: &PgPool, org_id: i32, status: &str) -> String {
        let sub_id = format!("sub_{org_id}");
        sqlx::query(
            "INSERT INTO subscriptions (organization_id, plan_id, status, stripe_subscription_id) \
             SELECT $1, id, $2, $3 FROM plans WHERE code = 'organization'",
        )
        .bind(org_id)
        .bind(status)
        .bind(&sub_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("insert subscription: {e}"));
        sub_id
    }

    async fn stripe_with_quantity(sub_id: &str, quantity: i64) -> MockServer {
        let stripe = MockServer::start().await;
        unsafe {
            std::env::set_var("STRIPE_API_BASE", stripe.uri());
            std::env::set_var("STRIPE_SECRET_KEY", "sk_test_seats");
        }
        Mock::given(method("GET"))
            .and(path(format!("/v1/subscriptions/{sub_id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": sub_id,
                "items": { "data": [{ "id": "si_1", "quantity": quantity }] },
            })))
            .mount(&stripe)
            .await;
        stripe
    }

    fn clear_stripe_env() {
        unsafe {
            std::env::remove_var("STRIPE_API_BASE");
            std::env::remove_var("STRIPE_SECRET_KEY");
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sync_sets_the_quantity_to_the_user_count() {
        let pool = test_pool().await;
        let org_id = org_with_users(&pool, 3).await;
        let sub_id = subscribe(&pool, org_id, "active").await;
        let stripe = stripe_with_quantity(&sub_id, 1).await;
        Mock::given(method("POST"))
            .and(path(format!("/v1/subscriptions/{sub_id}")))
            .and(body_string_contains("items%5B0%5D%5Bid%5D=si_1"))
            .and(body_string_contains("items%5B0%5D%5Bquantity%5D=3"))
            .and(body_string_contains("proration_behavior=create_prorations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&stripe)
            .await;

        sync_org_seats(&pool, org_id).await;
        clear_stripe_env();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_matching_quantity_writes_nothing_to_stripe() {
        let pool = test_pool().await;
        let org_id = org_with_users(&pool, 2).await;
        let sub_id = subscribe(&pool, org_id, "active").await;
        let stripe = stripe_with_quantity(&sub_id, 2).await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(0)
            .mount(&stripe)
            .await;

        sync_org_seats(&pool, org_id).await;
        clear_stripe_env();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn deprovisioned_users_are_not_billed_and_the_count_stays_positive() {
        let pool = test_pool().await;
        let org_id = org_with_users(&pool, 2).await;
        assert_eq!(billable_seats(&pool, org_id).await.unwrap_or(0), 2);

        sqlx::query("UPDATE users SET account_type = 'guest' WHERE organization_id = $1")
            .bind(org_id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("deprovision: {e}"));
        assert_eq!(billable_seats(&pool, org_id).await.unwrap_or(0), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_canceled_subscription_is_left_alone() {
        let pool = test_pool().await;
        let org_id = org_with_users(&pool, 3).await;
        let sub_id = subscribe(&pool, org_id, "canceled").await;
        let stripe = stripe_with_quantity(&sub_id, 1).await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(0)
            .mount(&stripe)
            .await;

        sync_org_seats(&pool, org_id).await;
        clear_stripe_env();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn the_hourly_reconcile_corrects_a_missed_change() {
        let pool = test_pool().await;
        let org_id = org_with_users(&pool, 4).await;
        let sub_id = subscribe(&pool, org_id, "active").await;
        let stripe = stripe_with_quantity(&sub_id, 1).await;
        Mock::given(method("POST"))
            .and(path(format!("/v1/subscriptions/{sub_id}")))
            .and(body_string_contains("items%5B0%5D%5Bquantity%5D=4"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&stripe)
            .await;
        // Other orgs' subscriptions in the shared test DB read as Stripe errors,
        // which are logged and skipped.
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({})))
            .mount(&stripe)
            .await;

        reconcile_org_seats(&pool).await;
        clear_stripe_env();
    }
}
