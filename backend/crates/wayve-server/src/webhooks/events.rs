// Event catalog and the `emit()` helper every producer calls. `emit()` fans one
// event out into a `webhook_deliveries` row per matching endpoint; the
// dispatcher does the sending.

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
    /// Fires when a direct or channel message is persisted. The payload is
    /// metadata only: bodies are end-to-end encrypted and the server cannot
    /// decrypt them.
    ChatMessageSent,
    /// Fires when a new chat channel is created.
    ChatChannelCreated,
    /// Synthetic event for `POST /api/webhooks/{id}/test`, so customers can
    /// verify their handler without waiting for a real producer. That handler
    /// enqueues directly, so the variant is in the catalog even though no
    /// producer calls `emit(.., Event::Ping, ..)`.
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

    /// The complete set, for the dashboard's "subscribe to all events" checkbox
    /// and the OpenAPI spec.
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

/// Whose event this is, which drives the endpoints that receive the delivery.
#[derive(Debug, Clone, Copy)]
pub enum EventOwner {
    User {
        id: i32,
        organization_id: Option<i32>,
    },
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

/// Emit an event. Fan-out is a single `INSERT … SELECT`, so a producer firing
/// into 100 endpoints still pays one round-trip.
///
/// Errors are logged, never propagated: a webhook fan-out failure must not
/// block the producer's own write, which has already succeeded. Webhooks are
/// best-effort by contract, so a row that fails to insert is simply lost.
#[instrument(target = "webhook", skip(pool, data), fields(event = event.as_str()))]
pub async fn emit(pool: &PgPool, owner: EventOwner, event: Event, data: serde_json::Value) {
    let EventOwner::User {
        id: user_id,
        organization_id,
    } = owner;
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

    // An endpoint fires if it belongs to the producer's user_id, or it is
    // org-wide and the producer is inside that org. The event-type match accepts
    // the literal type or a `*` wildcard.
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
