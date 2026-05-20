// Database-level guardrails on the billing projection. The Rust code freely
// inserts rows into `billing_customers`, `entitlements`, and `subscriptions`;
// these tests pin the schema invariants that keep stripe-driven billing safe:
//   - exactly one owner per row (user XOR organization),
//   - one billing customer per owner (idempotent webhook handling),
//   - one entitlement row per owner (the materialized snapshot the app reads
//     on every request), and
//   - `webhook_events.stripe_event_id` is UNIQUE so a re-delivered Stripe
//     event is a no-op rather than double-applied.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::PgPool;

    async fn insert_org(pool: &PgPool, name: &str) -> i32 {
        sqlx::query_scalar::<_, i32>("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"))
    }

    async fn cleanup(pool: &PgPool, user_ids: &[i32], org_ids: &[i32]) {
        for id in user_ids {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
        for id in org_ids {
            let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    #[actix_web::test]
    async fn billing_customers_rejects_row_with_no_owner() {
        let pool = test_pool().await;
        // owner check: at least one of user_id / organization_id is NOT NULL.
        let result = sqlx::query(
            "INSERT INTO billing_customers (user_id, organization_id, stripe_customer_id) \
             VALUES (NULL, NULL, $1)",
        )
        .bind(format!("cus_{}", uuid::Uuid::new_v4()))
        .execute(&pool)
        .await;
        assert!(
            result.is_err(),
            "row with no owner must violate billing_customers_owner_chk"
        );
    }

    #[actix_web::test]
    async fn billing_customers_rejects_row_with_both_owners() {
        // The other half of the CHECK constraint: a row may not be owned by
        // both a user *and* an organization — otherwise webhooks have two
        // valid update targets and double-apply.
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;
        let org_id = insert_org(&pool, &format!("Billing Both {}", random_email())).await;

        let result = sqlx::query(
            "INSERT INTO billing_customers (user_id, organization_id, stripe_customer_id) \
             VALUES ($1, $2, $3)",
        )
        .bind(user_id)
        .bind(org_id)
        .bind(format!("cus_{}", uuid::Uuid::new_v4()))
        .execute(&pool)
        .await;
        assert!(
            result.is_err(),
            "row with both owners must violate billing_customers_owner_chk"
        );

        cleanup(&pool, &[user_id], &[org_id]).await;
    }

    #[actix_web::test]
    async fn one_billing_customer_per_owner() {
        // The partial UNIQUE indexes are what make webhook idempotency
        // possible — Rust code can `INSERT ... ON CONFLICT (user_id) DO ...`
        // safely. Pin them so a future migration can't drop them silently.
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;

        sqlx::query("INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)")
            .bind(user_id)
            .bind(format!("cus_{}", uuid::Uuid::new_v4()))
            .execute(&pool)
            .await
            .unwrap();

        let dup = sqlx::query(
            "INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)",
        )
        .bind(user_id)
        .bind(format!("cus_{}", uuid::Uuid::new_v4()))
        .execute(&pool)
        .await;
        assert!(
            dup.is_err(),
            "a second billing_customers row for the same user must be rejected"
        );

        let _ = sqlx::query("DELETE FROM billing_customers WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
        cleanup(&pool, &[user_id], &[]).await;
    }

    #[actix_web::test]
    async fn one_entitlement_row_per_owner() {
        // Entitlements is the snapshot the app reads on every request to
        // decide whether to honor a feature. Duplicates would let two
        // contradictory rows coexist and the first-wins query would be
        // nondeterministic.
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("Ent Single {}", random_email())).await;

        sqlx::query(
            "INSERT INTO entitlements (organization_id, plan_code, storage_limit_bytes, seat_limit, active) \
             VALUES ($1, 'organization', -1, 100, TRUE)",
        )
        .bind(org_id)
        .execute(&pool)
        .await
        .unwrap();

        let dup = sqlx::query(
            "INSERT INTO entitlements (organization_id, plan_code, storage_limit_bytes, seat_limit, active) \
             VALUES ($1, 'enterprise', -1, 1000, TRUE)",
        )
        .bind(org_id)
        .execute(&pool)
        .await;
        assert!(
            dup.is_err(),
            "a second entitlements row for the same org must be rejected"
        );

        let _ = sqlx::query("DELETE FROM entitlements WHERE organization_id = $1")
            .bind(org_id)
            .execute(&pool)
            .await;
        cleanup(&pool, &[], &[org_id]).await;
    }

    #[actix_web::test]
    async fn webhook_event_id_uniqueness_protects_against_replay() {
        // Stripe occasionally re-delivers the same event. If we didn't enforce
        // uniqueness here, a re-delivery of `invoice.payment_succeeded` could
        // mint a second invoice row.
        let pool = test_pool().await;
        let event_id = format!("evt_{}", uuid::Uuid::new_v4());

        sqlx::query("INSERT INTO webhook_events (stripe_event_id, event_type) VALUES ($1, $2)")
            .bind(&event_id)
            .bind("invoice.payment_succeeded")
            .execute(&pool)
            .await
            .unwrap();

        // The application-level pattern is INSERT ... ON CONFLICT DO NOTHING,
        // and the constraint is what makes that pattern correct.
        let dup =
            sqlx::query("INSERT INTO webhook_events (stripe_event_id, event_type) VALUES ($1, $2)")
                .bind(&event_id)
                .bind("invoice.payment_succeeded")
                .execute(&pool)
                .await;
        assert!(dup.is_err(), "duplicate stripe_event_id must be rejected");

        let _ = sqlx::query("DELETE FROM webhook_events WHERE stripe_event_id = $1")
            .bind(&event_id)
            .execute(&pool)
            .await;
    }

    #[actix_web::test]
    async fn baseline_plan_catalog_is_seeded() {
        // The init.sql seed for the four canonical plans is a load-bearing
        // production detail — billing handlers look these up by `code`. If a
        // migration drops the seed, paying customers can't be enrolled.
        let pool = test_pool().await;

        let codes: Vec<String> =
            sqlx::query_scalar("SELECT code FROM plans WHERE code IN ($1, $2, $3, $4)")
                .bind("basic_user")
                .bind("advance_user")
                .bind("organization")
                .bind("enterprise")
                .fetch_all(&pool)
                .await
                .unwrap();

        for expected in ["basic_user", "advance_user", "organization", "enterprise"] {
            assert!(
                codes.iter().any(|c| c == expected),
                "plan {expected} missing from catalog: {codes:?}"
            );
        }
    }
}
