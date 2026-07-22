//! AI triage for Workspace tickets: ask the configured model (Claude in prod via
//! `ANTHROPIC_API_KEY`) for a 1–5 priority from the ticket's title + description,
//! then update the row. Everything here is best-effort and runs in the
//! background so ticket creation never blocks on — or fails because of — the AI.

use crate::ai::{agent, provider};
use crate::prelude::*;
use tracing::{info, warn};

/// Ask the model for a priority (1–5) given the ticket text. Returns None when no
/// AI is configured for the user or the reply can't be read as a digit — the
/// caller then leaves the existing priority untouched.
pub async fn suggest_priority(
    pool: &PgPool,
    user_id: i32,
    name: &str,
    description: &str,
) -> Option<i16> {
    let ai = provider::resolve_ai_for_user(pool, user_id)
        .await
        .ok()
        .flatten()?;

    let prompt = format!(
        "You are triaging an engineering/support ticket. Read the title and \
         description and reply with ONLY a single digit for its priority:\n\
         5 = urgent/critical (outage, data loss, security, many users blocked)\n\
         4 = high (broken feature, no workaround)\n\
         3 = normal (default)\n\
         2 = low (minor/cosmetic, easy workaround)\n\
         1 = trivial (nice-to-have)\n\
         Reply with just the digit 1-5, no other text.\n\n\
         Title: {name}\n\nDescription: {description}"
    );

    let reply = agent::complete(&ai, &prompt).await.ok()?;
    parse_priority(&reply)
}

/// First 1–5 digit in the reply, clamped to the valid range.
fn parse_priority(reply: &str) -> Option<i16> {
    reply
        .chars()
        .find_map(|c| c.to_digit(10))
        .map(|d| (d as i16).clamp(1, 5))
}

/// Fire-and-forget: triage `ticket_id` and write the suggested priority. Safe to
/// call from a request handler — it spawns and returns immediately. Uses actix's
/// current-thread runtime (`rt::spawn`) rather than `tokio::spawn` because the AI
/// client future is not `Send` (the same reason actix handlers aren't `Send`).
pub fn spawn(pool: PgPool, ticket_id: i32, user_id: i32, name: String, description: String) {
    actix_web::rt::spawn(async move {
        let Some(priority) = suggest_priority(&pool, user_id, &name, &description).await else {
            return;
        };
        match sqlx::query(
            "UPDATE workspace_tickets SET priority = $1, updated_at = NOW() WHERE id = $2",
        )
        .bind(priority)
        .bind(ticket_id)
        .execute(&pool)
        .await
        {
            Ok(_) => info!(target: "worker", ticket_id, priority, "ai-triaged ticket priority"),
            Err(e) => {
                warn!(target: "worker", ticket_id, error = %e, "triage priority update failed")
            }
        }
    });
}
