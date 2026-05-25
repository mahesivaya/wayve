// Webhook delivery worker.
//
// Polls `webhook_deliveries` for ready rows (`status = 'pending' AND
// next_attempt_at <= NOW()`), POSTs the envelope to the endpoint with an
// HMAC-SHA256 signature, and either marks the row delivered or schedules
// the next retry.
//
// Retry policy is the hardcoded `RETRY_SCHEDULE` array. Endpoints that
// accumulate too many consecutive failures are auto-disabled — the customer
// must re-enable them from the dashboard once their endpoint is healthy.

use crate::prelude::*;
use chrono::{Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::Duration;
use tracing::{error, info, instrument, warn};

type HmacSha256 = Hmac<Sha256>;

/// Backoff between attempts. The first attempt fires immediately when
/// `emit()` inserts the row with `next_attempt_at = NOW()`. After that
/// we space retries to ride out brief outages without spamming a broken
/// endpoint.
const RETRY_SCHEDULE_MINUTES: &[i64] = &[1, 5];

/// Auto-disable after this many consecutive failed deliveries.
const AUTO_DISABLE_THRESHOLD: i32 = 20;

/// How often the worker wakes up to look for ready deliveries.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Per-delivery HTTP request timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Spawn the delivery worker. Returns immediately; the loop runs forever
/// inside a tokio task.
pub async fn spawn_dispatcher(pool: PgPool) {
    let client = match reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // Defence-in-depth: limit redirects so a misconfigured endpoint
        // can't make us follow into someone else's network. A correct
        // webhook receiver should never 3xx.
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            error!(target: "webhook", error = ?e, "could not build webhook HTTP client");
            return;
        }
    };
    info!(target: "webhook", "webhook dispatcher started");
    loop {
        if let Err(e) = run_iteration(&pool, &client).await {
            warn!(target: "webhook", error = ?e, "dispatcher iteration failed");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[instrument(target = "webhook", skip(pool, client))]
async fn run_iteration(pool: &PgPool, client: &reqwest::Client) -> Result<()> {
    // Claim up to 25 deliveries per tick. `FOR UPDATE SKIP LOCKED`
    // means we can safely run multiple dispatchers concurrently in the
    // future without double-sending — for now there's only one.
    let rows = sqlx::query(
        r#"
        WITH claimed AS (
            SELECT id FROM webhook_deliveries
             WHERE status = 'pending'
               AND next_attempt_at <= NOW()
             ORDER BY next_attempt_at
             FOR UPDATE SKIP LOCKED
             LIMIT 25
        )
        UPDATE webhook_deliveries d
           SET attempt_count = d.attempt_count + 1,
               updated_at = NOW()
          FROM claimed
         WHERE d.id = claimed.id
        RETURNING d.id, d.endpoint_id, d.event_id, d.event_type,
                  d.payload, d.attempt_count
        "#,
    )
    .fetch_all(pool)
    .await?;

    for row in rows {
        let delivery_id: i64 = row.get("id");
        let endpoint_id: i32 = row.get("endpoint_id");
        let event_id: String = row.get("event_id");
        let event_type: String = row.get("event_type");
        let payload: serde_json::Value = row.get("payload");
        let attempt_count: i32 = row.get("attempt_count");

        // Pull the endpoint freshly each delivery — the customer may have
        // disabled, deleted, or moved its URL between attempts.
        let endpoint = sqlx::query(
            "SELECT url, secret, enabled FROM webhook_endpoints WHERE id = $1",
        )
        .bind(endpoint_id)
        .fetch_optional(pool)
        .await?;
        let Some(endpoint) = endpoint else {
            // Endpoint was deleted; abandon the delivery.
            mark_abandoned(pool, delivery_id, 0, "endpoint deleted").await;
            continue;
        };
        let enabled: bool = endpoint.get("enabled");
        if !enabled {
            mark_abandoned(pool, delivery_id, 0, "endpoint disabled").await;
            continue;
        }
        let url: String = endpoint.get("url");
        let secret: String = endpoint.get("secret");

        deliver(
            pool,
            client,
            DeliveryJob {
                delivery_id,
                endpoint_id,
                event_id: &event_id,
                event_type: &event_type,
                payload: &payload,
                attempt_count,
                url: &url,
                secret: &secret,
            },
        )
        .await;
    }
    Ok(())
}

struct DeliveryJob<'a> {
    delivery_id: i64,
    endpoint_id: i32,
    event_id: &'a str,
    event_type: &'a str,
    payload: &'a serde_json::Value,
    attempt_count: i32,
    url: &'a str,
    secret: &'a str,
}

async fn deliver(pool: &PgPool, client: &reqwest::Client, job: DeliveryJob<'_>) {
    let body = match serde_json::to_vec(job.payload) {
        Ok(b) => b,
        Err(e) => {
            error!(target: "webhook", error = ?e, "could not serialize payload");
            mark_abandoned(pool, job.delivery_id, 0, "payload serialization failed").await;
            return;
        }
    };
    let timestamp = Utc::now().timestamp();
    let signature = sign_body(job.secret, timestamp, &body);

    let result = client
        .post(job.url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "Wayve-Webhook/2026.05")
        .header("Wayve-Event-Id", job.event_id)
        .header("Wayve-Event-Type", job.event_type)
        .header("Wayve-Signature", format!("t={timestamp},v1={signature}"))
        .body(body)
        .send()
        .await;

    match result {
        Ok(resp) => {
            let status = resp.status();
            let excerpt = resp
                .text()
                .await
                .ok()
                .map(|t| t.chars().take(500).collect::<String>())
                .unwrap_or_default();
            if status.is_success() {
                mark_delivered(pool, job.delivery_id, job.endpoint_id, status.as_u16(), &excerpt)
                    .await;
            } else if status.is_client_error()
                && status.as_u16() != 408
                && status.as_u16() != 429
            {
                // 4xx (other than rate-limit / timeout) means the receiver
                // is rejecting the request shape — retrying won't help.
                mark_abandoned_with_response(
                    pool,
                    job.delivery_id,
                    job.endpoint_id,
                    status.as_u16(),
                    &excerpt,
                )
                .await;
            } else {
                schedule_retry_or_abandon(
                    pool,
                    job.delivery_id,
                    job.endpoint_id,
                    job.attempt_count,
                    Some(status.as_u16()),
                    &excerpt,
                )
                .await;
            }
        }
        Err(e) => {
            let msg = format!("transport: {e}");
            schedule_retry_or_abandon(
                pool,
                job.delivery_id,
                job.endpoint_id,
                job.attempt_count,
                None,
                &msg,
            )
            .await;
        }
    }
}

fn sign_body(secret: &str, timestamp: i64, body: &[u8]) -> String {
    // Stripe-style: HMAC-SHA256 over `<timestamp>.<body>` using the
    // endpoint's secret. Receivers verify by recomputing and comparing in
    // constant time; the timestamp also lets them reject replayed requests.
    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return String::new(),
    };
    mac.update(format!("{timestamp}.").as_bytes());
    mac.update(body);
    let bytes = mac.finalize().into_bytes();
    hex_encode(&bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

async fn mark_delivered(
    pool: &PgPool,
    delivery_id: i64,
    endpoint_id: i32,
    status: u16,
    excerpt: &str,
) {
    let _ = sqlx::query(
        r#"
        UPDATE webhook_deliveries SET
          status = 'delivered',
          http_status = $1,
          response_excerpt = $2,
          delivered_at = NOW(),
          updated_at = NOW()
        WHERE id = $3
        "#,
    )
    .bind(status as i32)
    .bind(excerpt)
    .bind(delivery_id)
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = NOW() WHERE id = $1",
    )
    .bind(endpoint_id)
    .execute(pool)
    .await;
}

async fn mark_abandoned(pool: &PgPool, delivery_id: i64, http_status: u16, reason: &str) {
    let _ = sqlx::query(
        r#"
        UPDATE webhook_deliveries SET
          status = 'abandoned',
          http_status = $1,
          response_excerpt = $2,
          updated_at = NOW()
        WHERE id = $3
        "#,
    )
    .bind(http_status as i32)
    .bind(reason)
    .bind(delivery_id)
    .execute(pool)
    .await;
}

async fn mark_abandoned_with_response(
    pool: &PgPool,
    delivery_id: i64,
    endpoint_id: i32,
    status: u16,
    excerpt: &str,
) {
    mark_abandoned(pool, delivery_id, status, excerpt).await;
    record_failure(pool, endpoint_id).await;
}

#[allow(clippy::too_many_arguments)]
async fn schedule_retry_or_abandon(
    pool: &PgPool,
    delivery_id: i64,
    endpoint_id: i32,
    attempt_count: i32,
    status: Option<u16>,
    excerpt: &str,
) {
    // `attempt_count` was already incremented to N for the just-completed
    // attempt; we look up the (N)th index in the schedule to find the next
    // delay. If we've exhausted the schedule, abandon.
    let index = (attempt_count as usize).saturating_sub(1);
    if let Some(&delay_min) = RETRY_SCHEDULE_MINUTES.get(index) {
        let next_at = Utc::now() + ChronoDuration::minutes(delay_min);
        let _ = sqlx::query(
            r#"
            UPDATE webhook_deliveries SET
              status = 'pending',
              http_status = $1,
              response_excerpt = $2,
              next_attempt_at = $3,
              updated_at = NOW()
            WHERE id = $4
            "#,
        )
        .bind(status.map(|s| s as i32))
        .bind(excerpt)
        .bind(next_at)
        .bind(delivery_id)
        .execute(pool)
        .await;
    } else {
        let _ = sqlx::query(
            r#"
            UPDATE webhook_deliveries SET
              status = 'failed',
              http_status = $1,
              response_excerpt = $2,
              updated_at = NOW()
            WHERE id = $3
            "#,
        )
        .bind(status.map(|s| s as i32))
        .bind(excerpt)
        .bind(delivery_id)
        .execute(pool)
        .await;
        record_failure(pool, endpoint_id).await;
    }
}

async fn record_failure(pool: &PgPool, endpoint_id: i32) {
    let _ = sqlx::query(
        r#"
        UPDATE webhook_endpoints SET
          consecutive_failures = consecutive_failures + 1,
          last_failure_at = NOW(),
          enabled = CASE WHEN consecutive_failures + 1 >= $1 THEN false ELSE enabled END,
          updated_at = NOW()
        WHERE id = $2
        "#,
    )
    .bind(AUTO_DISABLE_THRESHOLD)
    .bind(endpoint_id)
    .execute(pool)
    .await;
}
