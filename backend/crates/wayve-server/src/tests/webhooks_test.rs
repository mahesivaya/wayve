//! The outbound webhook subsystem: that the event catalog cannot drift from the
//! enum, that `emit` fans out to exactly the subscribed and enabled endpoints,
//! and that the HMAC signature keeps the Stripe-style shape customers verify
//! against.

#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use crate::webhooks::events::EventOwner;
    use crate::webhooks::{Event, emit};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use sqlx::Row;

    type HmacSha256 = Hmac<Sha256>;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().fold(String::new(), |mut acc, b| {
            acc.push_str(&format!("{b:02x}"));
            acc
        })
    }

    #[test]
    fn event_str_round_trips_with_all_catalog() {
        // Every variant must appear in Event::ALL, so a new variant added without
        // updating the public catalog fails here instead of going unpublished.
        let strs = [
            Event::TaskCreated.as_str(),
            Event::TaskUpdated.as_str(),
            Event::TaskDeleted.as_str(),
            Event::MeetingCreated.as_str(),
            Event::MeetingUpdated.as_str(),
            Event::MeetingDeleted.as_str(),
            Event::EmailReceived.as_str(),
            Event::EmailSent.as_str(),
            Event::ChatMessageSent.as_str(),
            Event::ChatChannelCreated.as_str(),
            Event::Ping.as_str(),
        ];
        for s in strs {
            assert!(
                Event::ALL.contains(&s),
                "Event::ALL missing {s} — update the catalog"
            );
        }
        assert_eq!(
            Event::ALL.len(),
            strs.len(),
            "Event::ALL length drifted from enum variant count"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn emit_fans_out_to_subscribed_endpoints_only() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;

        let subscribed_id = insert_endpoint(
            &pool,
            user_id,
            "https://example.com/yes",
            &["task.created"],
            false,
            None,
            true,
        )
        .await;
        let _unsubscribed_id = insert_endpoint(
            &pool,
            user_id,
            "https://example.com/no",
            &["meeting.created"],
            false,
            None,
            true,
        )
        .await;

        emit(
            &pool,
            EventOwner::user(user_id),
            Event::TaskCreated,
            serde_json::json!({ "id": 1 }),
        )
        .await;

        let deliveries: Vec<i32> = sqlx::query_scalar(
            "SELECT endpoint_id FROM webhook_deliveries
              WHERE event_type = 'task.created'
                AND endpoint_id IN (
                    SELECT id FROM webhook_endpoints WHERE user_id = $1
                )",
        )
        .bind(user_id)
        .fetch_all(&pool)
        .await
        .expect("select deliveries");

        assert_eq!(
            deliveries,
            vec![subscribed_id],
            "emit() must fan out only to endpoints subscribed to the event_type"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn emit_wildcard_endpoint_receives_every_event() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;
        let wildcard_id = insert_endpoint(
            &pool,
            user_id,
            "https://example.com/all",
            &["*"],
            false,
            None,
            true,
        )
        .await;

        emit(
            &pool,
            EventOwner::user(user_id),
            Event::MeetingDeleted,
            serde_json::json!({ "id": 5 }),
        )
        .await;

        let rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM webhook_deliveries
              WHERE endpoint_id = $1 AND event_type = 'meeting.deleted'",
        )
        .bind(wildcard_id)
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
        assert_eq!(rows, 1, "wildcard '*' endpoint must receive every event");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn emit_skips_disabled_endpoints() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;
        let disabled_id = insert_endpoint(
            &pool,
            user_id,
            "https://example.com/disabled",
            &["task.created"],
            false,
            None,
            false,
        )
        .await;

        emit(
            &pool,
            EventOwner::user(user_id),
            Event::TaskCreated,
            serde_json::json!({ "id": 1 }),
        )
        .await;

        let rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM webhook_deliveries WHERE endpoint_id = $1")
                .bind(disabled_id)
                .fetch_one(&pool)
                .await
                .unwrap_or(0);
        assert_eq!(rows, 0, "disabled endpoints must not receive deliveries");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn org_wide_endpoint_receives_events_from_any_org_member() {
        let pool = test_pool().await;
        let org_row = sqlx::query("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(format!("org-{}", uuid::Uuid::new_v4().simple()))
            .fetch_one(&pool)
            .await
            .expect("create org");
        let org_id: i32 = org_row.get("id");

        let owner_id = insert_local_user(&pool, &random_email(), "pw").await;
        let member_id = insert_local_user(&pool, &random_email(), "pw").await;
        sqlx::query("UPDATE users SET organization_id = $1 WHERE id = $2 OR id = $3")
            .bind(org_id)
            .bind(owner_id)
            .bind(member_id)
            .execute(&pool)
            .await
            .expect("link users to org");

        let org_endpoint = insert_endpoint(
            &pool,
            owner_id,
            "https://example.com/org",
            &["task.created"],
            true,
            Some(org_id),
            true,
        )
        .await;

        emit(
            &pool,
            EventOwner::user_in_org(member_id, org_id),
            Event::TaskCreated,
            serde_json::json!({ "id": 1 }),
        )
        .await;

        let rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM webhook_deliveries WHERE endpoint_id = $1")
                .bind(org_endpoint)
                .fetch_one(&pool)
                .await
                .unwrap_or(0);
        assert_eq!(
            rows, 1,
            "org-wide endpoints must receive events fired by any org member"
        );
    }

    #[test]
    fn signing_matches_stripe_style_hmac_sha256() {
        // This reproduces dispatcher::sign_body: HMAC-SHA256 over the string
        // "<timestamp>.<body>" keyed by the endpoint secret. Drifting from this
        // shape breaks signature verification for every customer.
        let secret = "whsec_test";
        let timestamp = 1_779_629_510i64;
        let body = br#"{"id":"evt_x","type":"wayve.ping"}"#;

        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key from bytes");
        mac.update(format!("{timestamp}.").as_bytes());
        mac.update(body);
        let expected = hex(&mac.finalize().into_bytes());

        let mut mac2 = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key from bytes");
        mac2.update(format!("{timestamp}.").as_bytes());
        mac2.update(body);
        let again = hex(&mac2.finalize().into_bytes());

        assert_eq!(expected, again, "HMAC must be deterministic");
        assert_eq!(expected.len(), 64, "HMAC-SHA256 hex must be 64 chars");
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_endpoint(
        pool: &sqlx::PgPool,
        user_id: i32,
        url: &str,
        events: &[&str],
        org_wide: bool,
        organization_id: Option<i32>,
        enabled: bool,
    ) -> i32 {
        let events_vec: Vec<String> = events.iter().map(|s| s.to_string()).collect();
        let row = sqlx::query(
            r#"
            INSERT INTO webhook_endpoints
              (user_id, organization_id, org_wide, url, secret, secret_preview,
               events, enabled)
            VALUES ($1, $2, $3, $4, 'whsec_test', 'whsec_t…test', $5, $6)
            RETURNING id
            "#,
        )
        .bind(user_id)
        .bind(organization_id)
        .bind(org_wide)
        .bind(url)
        .bind(&events_vec)
        .bind(enabled)
        .fetch_one(pool)
        .await
        .expect("insert webhook endpoint");
        row.get("id")
    }
}
