//! Self-serve upgrade from a personal account to an organization. The paid path
//! moves money, so the guards here matter: no org before Stripe says paid, no
//! second org for the same owner, and no finalizing someone else's upgrade.

#[cfg(test)]
mod tests {
    use crate::billing::organization_upgrade::{
        finalize_organization_upgrade, start_organization_upgrade,
    };
    use crate::routes::user::finalize_org_signup_inner;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use crate::workspace::handler::ensure_default_team;
    use actix_web::{App, test as actix_test, web};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn unique_name() -> String {
        format!("Upgrade Test {}", random_email().replace(['@', '.'], ""))
    }

    /// `(status, body)` of POST /billing/organization-upgrade.
    async fn start(
        pool: &PgPool,
        (user_id, email): (i32, &str),
        plan_code: &str,
        name: &str,
    ) -> (u16, serde_json::Value) {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(start_organization_upgrade),
        )
        .await;
        let req = actix_test::TestRequest::post()
            .uri("/billing/organization-upgrade")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, email)),
            ))
            .set_json(serde_json::json!({ "plan_code": plan_code, "name": name }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        let status = resp.status().as_u16();
        let body = actix_test::read_body(resp).await;
        (status, serde_json::from_slice(&body).unwrap_or_default())
    }

    async fn finalize(
        pool: &PgPool,
        (user_id, email): (i32, &str),
        pending_id: i32,
    ) -> (u16, serde_json::Value) {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(finalize_organization_upgrade),
        )
        .await;
        let req = actix_test::TestRequest::post()
            .uri(&format!(
                "/billing/organization-upgrade/{pending_id}/finalize"
            ))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, email)),
            ))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        let status = resp.status().as_u16();
        let body = actix_test::read_body(resp).await;
        (status, serde_json::from_slice(&body).unwrap_or_default())
    }

    async fn account(pool: &PgPool, user_id: i32) -> (String, Option<i32>) {
        sqlx::query_as("SELECT account_type, organization_id FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("load account: {e}"))
    }

    async fn insert_pending(pool: &PgPool, user_id: i32, name: &str) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO pending_org_signups \
                (user_id, name, plan_code, stripe_customer_id, stripe_subscription_id) \
             VALUES ($1, $2, 'organization', $3, $4) RETURNING id",
        )
        .bind(user_id)
        .bind(name)
        .bind(format!("cus_{}", random_email()))
        .bind(format!("sub_{}", random_email()))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert pending: {e}"))
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn free_plan_makes_the_user_owner_with_the_plans_limits() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;

        let (status, body) = start(
            &pool,
            (user_id, &email),
            "business_startups",
            &unique_name(),
        )
        .await;
        assert_eq!(status, 201, "{body}");
        let org_id = body["organization_id"].as_i64().map(|id| id as i32);

        let (account_type, organization_id) = account(&pool, user_id).await;
        assert_eq!(account_type, "organization_admin");
        assert_eq!(organization_id, org_id);

        let role: String = sqlx::query_scalar(
            "SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2",
        )
        .bind(user_id)
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("load role: {e}"));
        assert_eq!(role, "owner");

        let (plan_code, seats): (Option<String>, i32) = sqlx::query_as(
            "SELECT plan_code, seat_limit FROM entitlements WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("load entitlement: {e}"));
        assert_eq!(plan_code.as_deref(), Some("business_startups"));
        assert_eq!(seats, 5, "must match the plan card's 'Up to 5 members'");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn upgrading_twice_is_refused_and_keeps_the_first_org() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;

        let (status, _) = start(
            &pool,
            (user_id, &email),
            "business_startups",
            &unique_name(),
        )
        .await;
        assert_eq!(status, 201);
        let before = account(&pool, user_id).await;

        let (status, _) = start(
            &pool,
            (user_id, &email),
            "business_startups",
            &unique_name(),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(account(&pool, user_id).await, before);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn enterprise_and_personal_plans_are_not_self_serve() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;

        for plan in ["enterprise", "advance_user", "no_such_plan"] {
            let (status, _) = start(&pool, (user_id, &email), plan, &unique_name()).await;
            assert_eq!(status, 400, "{plan}");
        }
        assert_eq!(account(&pool, user_id).await.1, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_taken_name_is_refused_even_with_different_punctuation() {
        let pool = test_pool().await;
        let name = unique_name();
        let first = random_email();
        let first_id = insert_local_user(&pool, &first, "pw").await;
        let (status, _) = start(&pool, (first_id, &first), "business_startups", &name).await;
        assert_eq!(status, 201);

        let second = random_email();
        let second_id = insert_local_user(&pool, &second, "pw").await;
        let (status, _) = start(
            &pool,
            (second_id, &second),
            "business_startups",
            &name.to_uppercase(),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(account(&pool, second_id).await.0, "personal");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn an_active_personal_subscription_must_be_canceled_first() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;
        sqlx::query(
            "INSERT INTO subscriptions (user_id, plan_id, status, stripe_subscription_id) \
             SELECT $1, id, 'active', $2 FROM plans WHERE code = 'advance_user'",
        )
        .bind(user_id)
        .bind(format!("sub_{}", random_email()))
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert subscription: {e}"));

        let (status, _) = start(
            &pool,
            (user_id, &email),
            "business_startups",
            &unique_name(),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(account(&pool, user_id).await.0, "personal");

        // Already set to end: it stops charging by itself, so it no longer blocks.
        sqlx::query("UPDATE subscriptions SET cancel_at_period_end = true WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("update subscription: {e}"));
        let (status, _) = start(
            &pool,
            (user_id, &email),
            "business_startups",
            &unique_name(),
        )
        .await;
        assert_eq!(status, 201);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finalize_creates_the_org_only_once_stripe_reports_paid() {
        let pool = test_pool().await;
        let stripe = MockServer::start().await;
        unsafe {
            std::env::set_var("STRIPE_API_BASE", stripe.uri());
            std::env::set_var("STRIPE_SECRET_KEY", "sk_test_upgrade");
        }
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;
        let pending_id = insert_pending(&pool, user_id, &unique_name()).await;

        // Unpaid: "not yet", and nothing is created.
        let unpaid = Mock::given(method("GET"))
            .and(path_regex("^/v1/subscriptions/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "status": "incomplete" })),
            )
            .mount_as_scoped(&stripe)
            .await;
        let (status, body) = finalize(&pool, (user_id, &email), pending_id).await;
        assert_eq!(status, 202, "{body}");
        assert!(body["organization_id"].is_null());
        assert_eq!(account(&pool, user_id).await.0, "personal");
        drop(unpaid);

        // Paid: created, and a repeat call returns the same org.
        Mock::given(method("GET"))
            .and(path_regex("^/v1/subscriptions/"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "status": "active" })),
            )
            .mount(&stripe)
            .await;
        let (status, first) = finalize(&pool, (user_id, &email), pending_id).await;
        assert_eq!(status, 200, "{first}");
        let (status, second) = finalize(&pool, (user_id, &email), pending_id).await;
        assert_eq!(status, 200);
        assert_eq!(first["organization_id"], second["organization_id"]);

        let (account_type, org_id) = account(&pool, user_id).await;
        assert_eq!(account_type, "organization_admin");

        let plan_code: String = sqlx::query_scalar(
            "SELECT p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id \
             WHERE s.organization_id = $1 AND s.status = 'active'",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("load subscription: {e}"));
        assert_eq!(plan_code, "organization");

        unsafe {
            std::env::remove_var("STRIPE_API_BASE");
            std::env::remove_var("STRIPE_SECRET_KEY");
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn another_users_upgrade_cannot_be_finalized() {
        let pool = test_pool().await;
        let owner_email = random_email();
        let owner = insert_local_user(&pool, &owner_email, "pw").await;
        let pending_id = insert_pending(&pool, owner, &unique_name()).await;

        let other_email = random_email();
        let other = insert_local_user(&pool, &other_email, "pw").await;
        let (status, _) = finalize(&pool, (other, &other_email), pending_id).await;
        assert_eq!(status, 404);
        assert_eq!(account(&pool, owner).await.0, "personal");
    }

    async fn teams_of(pool: &PgPool, org_id: i32) -> Vec<(String, String)> {
        sqlx::query_as("SELECT name, slug FROM teams WHERE organization_id = $1 ORDER BY id")
            .bind(org_id)
            .fetch_all(pool)
            .await
            .unwrap_or_else(|e| panic!("load teams: {e}"))
    }

    async fn roster_of(
        pool: &PgPool,
        org_id: i32,
    ) -> Vec<(String, Option<String>, Option<String>)> {
        sqlx::query_as(
            "SELECT m.name, m.role, m.email FROM team_members m \
             JOIN teams t ON t.id = m.team_id WHERE t.organization_id = $1 ORDER BY m.id",
        )
        .bind(org_id)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("load roster: {e}"))
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn upgrading_creates_a_team_named_after_the_org_with_the_admin_on_it() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;
        let name = unique_name();

        let (status, body) = start(&pool, (user_id, &email), "business_startups", &name).await;
        assert_eq!(status, 201, "{body}");
        let org_id = account(&pool, user_id)
            .await
            .1
            .unwrap_or_else(|| panic!("user must be in the new org"));

        let teams = teams_of(&pool, org_id).await;
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].0, name);

        let roster = roster_of(&pool, org_id).await;
        assert_eq!(roster.len(), 1);
        assert_eq!(roster[0].1.as_deref(), Some("Admin"));
        assert_eq!(roster[0].2.as_deref(), Some(email.as_str()));
        assert!(!roster[0].0.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn the_default_team_is_not_duplicated_or_restored() {
        let pool = test_pool().await;
        let name = unique_name();
        let org_id: i32 =
            sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
                .bind(&name)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("insert org: {e}"));
        let email = random_email();
        let admin = insert_local_user(&pool, &email, "pw").await;
        let mut conn = pool
            .acquire()
            .await
            .unwrap_or_else(|e| panic!("acquire: {e}"));

        // Created with no admin yet, then the first admin joins it, once.
        for who in [None, Some(admin), Some(admin)] {
            ensure_default_team(&mut conn, org_id, &name, who)
                .await
                .unwrap_or_else(|e| panic!("ensure team: {e}"));
        }
        assert_eq!(teams_of(&pool, org_id).await.len(), 1);
        assert_eq!(roster_of(&pool, org_id).await.len(), 1);

        // An owner who replaced it with their own team doesn't get it back.
        sqlx::query(
            "UPDATE teams SET name = 'Renamed', slug = 'renamed' WHERE organization_id = $1",
        )
        .bind(org_id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("rename team: {e}"));
        ensure_default_team(&mut conn, org_id, &name, Some(admin))
            .await
            .unwrap_or_else(|e| panic!("ensure team: {e}"));
        let teams = teams_of(&pool, org_id).await;
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].0, "Renamed");
    }

    /// The backstop for a browser closed right after paying: a signed Stripe event
    /// alone must create the org and record the renewal date.
    #[tokio::test]
    #[serial_test::serial]
    async fn the_webhook_finalizes_a_paid_upgrade_without_the_browser() {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        let pool = test_pool().await;
        let secret = "whsec_upgrade_test";
        unsafe { std::env::set_var("STRIPE_WEBHOOK_SECRET", secret) };
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;
        let pending_id = insert_pending(&pool, user_id, &unique_name()).await;
        let sub_id: String = sqlx::query_scalar(
            "SELECT stripe_subscription_id FROM pending_org_signups WHERE id = $1",
        )
        .bind(pending_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("load pending: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::billing::webhook_handler::stripe_webhook),
        )
        .await;
        let event = serde_json::json!({
            "id": format!("evt_{}", random_email()),
            "type": "customer.subscription.updated",
            "data": { "object": {
                "id": sub_id,
                "status": "active",
                "current_period_end": 1_900_000_000_i64,
                "metadata": { "org_pending": pending_id.to_string() },
            }},
        })
        .to_string();
        let timestamp = chrono::Utc::now().timestamp();
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .unwrap_or_else(|e| panic!("hmac key: {e}"));
        mac.update(format!("{timestamp}.{event}").as_bytes());
        let signature: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let req = actix_test::TestRequest::post()
            .uri("/billing/webhook")
            .insert_header(("Stripe-Signature", format!("t={timestamp},v1={signature}")))
            .set_payload(event)
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        unsafe { std::env::remove_var("STRIPE_WEBHOOK_SECRET") };
        assert_eq!(resp.status().as_u16(), 200);

        let (account_type, org_id) = account(&pool, user_id).await;
        assert_eq!(account_type, "organization_admin");
        let (status, has_period_end): (String, bool) = sqlx::query_as(
            "SELECT status, current_period_end IS NOT NULL FROM subscriptions \
             WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("load subscription: {e}"));
        assert_eq!(status, "active");
        assert!(has_period_end, "the next charge date must not stay blank");
    }

    /// A duplicate key aborts the transaction, so recording the failure in it
    /// would error and make Stripe retry the webhook forever.
    #[tokio::test]
    #[serial_test::serial]
    async fn a_name_lost_after_payment_marks_the_signup_failed() {
        let pool = test_pool().await;
        let name = unique_name();
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;
        let pending_id = insert_pending(&pool, user_id, &name).await;
        sqlx::query("INSERT INTO organizations (name, slug) VALUES ($1, $2)")
            .bind(&name)
            .bind(random_email())
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"));

        let result = finalize_org_signup_inner(&pool, pending_id)
            .await
            .unwrap_or_else(|e| panic!("finalize must not error: {e}"));
        assert_eq!(result, None);

        let status: String =
            sqlx::query_scalar("SELECT status FROM pending_org_signups WHERE id = $1")
                .bind(pending_id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("load pending: {e}"));
        assert_eq!(status, "failed");
        assert_eq!(account(&pool, user_id).await.0, "personal");
    }

    /// Two paid attempts must not move the owner out of the org the first made.
    #[tokio::test]
    #[serial_test::serial]
    async fn a_second_paid_attempt_does_not_move_the_owner() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "pw").await;
        let first = insert_pending(&pool, user_id, &unique_name()).await;
        let second = insert_pending(&pool, user_id, &unique_name()).await;

        let org = finalize_org_signup_inner(&pool, first)
            .await
            .unwrap_or_else(|e| panic!("first finalize: {e}"));
        assert!(org.is_some());

        let again = finalize_org_signup_inner(&pool, second)
            .await
            .unwrap_or_else(|e| panic!("second finalize: {e}"));
        assert_eq!(again, None);
        assert_eq!(account(&pool, user_id).await.1, org);
    }
}
