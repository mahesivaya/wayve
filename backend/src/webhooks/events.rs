// Event catalog + `emit()` helper.
//
// `emit()` is the single place every producer in the codebase calls. It fans
// out a single emitted event into one `webhook_deliveries` row per matching
// endpoint, leaving the dispatcher to actually send them.

use crate::prelude::*;
use chrono::Utc;
use tracing::{error, instrument};
use uuid::Uuid;

/// The catalog of event types we promise to keep stable. Adding to this list
/// is backwards-compatible; renaming or removing is a breaking change.
#[derive(Debug, Clone, Copy)]
pub enum Event {
    TaskCreated,
    TaskUpdated,
    TaskDeleted,
    MeetingCreated,
    MeetingUpdated,
    MeetingDeleted,
    /// Fires when the email sync worker ingests a row that didn't previously
    /// exist for the mailbox. NOT fired for body backfills or label updates.
    EmailReceived,
    /// Fires when /api/email/send returns 2xx from the upstream provider.
    EmailSent,
    /// Fires when a direct or channel message is persisted. Payload is
    /// metadata only — message bodies are end-to-end encrypted and the
    /// server cannot decrypt them.
    ChatMessageSent,
    /// Fires when a new chat channel is created.
    ChatChannelCreated,
    /// Synthetic event fired by the `POST /api/webhooks/{id}/test` endpoint
    /// so customers can verify their handler without waiting for a real
    /// producer. The test handler enqueues directly so this variant is in
    /// the catalog as `wayve.ping` even though no producer calls
    /// `emit(.., Event::Ping, ..)` yet.
    #[allow(dead_code)]
    Ping,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Event::TaskCreated => "task.created",
            Event::TaskUpdated => "task.updated",
            Event::TaskDeleted => "task.deleted",
            Event::MeetingCreated => "meeting.created",
            Event::MeetingUpdated => "meeting.updated",
            Event::MeetingDeleted => "meeting.deleted",
            Event::EmailReceived => "email.received",
            Event::EmailSent => "email.sent",
            Event::ChatMessageSent => "chat.message.sent",
            Event::ChatChannelCreated => "chat.channel.created",
            Event::Ping => "wayve.ping",
        }
    }

    /// The complete set, for the dashboard's "subscribe to all events"
    /// checkbox and for the OpenAPI spec / docs.
    pub const ALL: &'static [&'static str] = &[
        "task.created",
        "task.updated",
        "task.deleted",
        "meeting.created",
        "meeting.updated",
        "meeting.deleted",
        "email.received",
        "email.sent",
        "chat.message.sent",
        "chat.channel.created",
        "wayve.ping",
    ];
}

/// Whose event this is — drives which endpoints receive the delivery.
#[derive(Debug, Clone, Copy)]
pub enum EventOwner {
    User { id: i32, organization_id: Option<i32> },
}

impl EventOwner {
    pub fn user(user_id: i32) -> Self {
        EventOwner::User {
            id: user_id,
            organization_id: None,
        }
    }
    pub fn user_in_org(user_id: i32, organization_id: i32) -> Self {
        EventOwner::User {
            id: user_id,
            organization_id: Some(organization_id),
        }
    }
}

/// Emit an event. Fan-out is a single SQL `INSERT … SELECT` so a producer
/// firing into 100 matching endpoints still pays just one round-trip.
///
/// Errors are logged but never propagated — a webhook fan-out failure must
/// not block the underlying task/meeting/etc. write. This is by design: the
/// dispatcher will retry on its next tick if a row was inserted; a row that
/// failed to insert at all is lost, which is acceptable for v1 (the
/// producer's primary mutation has already succeeded; webhooks are
/// best-effort by contract).
#[instrument(target = "webhook", skip(pool, data), fields(event = event.as_str()))]
pub async fn emit(
    pool: &PgPool,
    owner: EventOwner,
    event: Event,
    data: serde_json::Value,
) {
    let EventOwner::User { id: user_id, organization_id } = owner;
    let event_id = format!("evt_{}", Uuid::new_v4().simple());
    let envelope = serde_json::json!({
        "id": event_id,
        "type": event.as_str(),
        "api_version": "2026.05",
        "created_at": Utc::now(),
        "owner": {
            "type": "user",
            "user_id": user_id,
            "organization_id": organization_id,
        },
        "data": data,
    });

    // Endpoints fire if either:
    //   1. They belong to the producer's user_id (personal subscription), OR
    //   2. They are org-wide AND the producer is inside that org.
    // The event-type match supports the literal type or a `*` wildcard.
    let result = sqlx::query(
        r#"
        INSERT INTO webhook_deliveries
          (endpoint_id, event_id, event_type, payload, next_attempt_at)
        SELECT id, $1, $2, $3, NOW()
          FROM webhook_endpoints
         WHERE enabled = true
           AND (
               (org_wide = false AND user_id = $4)
            OR (org_wide = true  AND $5::int IS NOT NULL AND organization_id = $5)
           )
           AND ($2 = ANY(events) OR '*' = ANY(events))
        "#,
    )
    .bind(&event_id)
    .bind(event.as_str())
    .bind(&envelope)
    .bind(user_id)
    .bind(organization_id)
    .execute(pool)
    .await;

    if let Err(e) = result {
        error!(
            target: "webhook",
            event = event.as_str(),
            user_id,
            error = ?e,
            "webhook fan-out failed"
        );
    }
}
