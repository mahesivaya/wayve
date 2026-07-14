//! Slack and Wayve message sync. Slack is enterprise-only and enterprise chat is
//! not E2E, so imported messages are stored under the server-AES at-rest layer and
//! render directly. The outbound bridge is best-effort and never fails its caller.

use crate::prelude::*;
use sqlx::Row;
use tracing::{info, warn};
use wayve_security::encryption::encrypt;

use super::client::SlackClient;
use super::models::SlackConnection;

struct LinkRow {
    id: i32,
    wayve_channel_id: i32,
    slack_channel_id: String,
    last_imported_ts: Option<String>,
}

/// Imported messages are attributed to `importer_user_id` and prefixed with their
/// Slack author so the origin is clear.
pub async fn import_all(
    pool: &PgPool,
    conn: &SlackConnection,
    importer_user_id: i32,
    only_channel: Option<&str>,
    limit: u32,
) -> Result<(i64, usize), AppError> {
    let client = SlackClient::new(conn);

    let rows = sqlx::query(
        "SELECT id, wayve_channel_id, slack_channel_id, last_imported_ts
           FROM slack_channel_links
          WHERE organization_id = $1
            AND ($2::text IS NULL OR slack_channel_id = $2)",
    )
    .bind(conn.organization_id)
    .bind(only_channel)
    .fetch_all(pool)
    .await?;

    let links: Vec<LinkRow> = rows
        .into_iter()
        .map(|r| LinkRow {
            id: r.get("id"),
            wayve_channel_id: r.get("wayve_channel_id"),
            slack_channel_id: r.get("slack_channel_id"),
            last_imported_ts: r.try_get("last_imported_ts").unwrap_or(None),
        })
        .collect();

    let mut total_imported = 0i64;
    let mut channels_touched = 0usize;
    // users.info is rate-limited and the same author repeats across many messages,
    // so each display name is resolved at most once per run.
    let mut author_cache: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for link in links {
        let mut messages = client
            .history(
                &link.slack_channel_id,
                link.last_imported_ts.as_deref(),
                limit,
            )
            .await?;
        // Slack returns newest-first, so reverse to insert in chronological order.
        messages.reverse();

        let mut newest_ts = link.last_imported_ts.clone();
        let mut imported_here = 0i64;

        for m in messages {
            if m.msg_type != "message" || m.subtype.is_some() {
                continue;
            }
            // Slack's `oldest` is inclusive, so the cursor message comes back and
            // must be skipped. Slack `ts` are fixed-width "secs.micros" strings,
            // so lexicographic order matches chronological order.
            if let Some(cursor) = link.last_imported_ts.as_deref()
                && m.ts.as_str() <= cursor
            {
                continue;
            }

            let author = match &m.user {
                Some(u) => match author_cache.get(u) {
                    Some(name) => name.clone(),
                    None => {
                        let name = client.user_name(u).await.unwrap_or_else(|| u.clone());
                        author_cache.insert(u.clone(), name.clone());
                        name
                    }
                },
                None => "slack".to_string(),
            };
            let text = client.resolve_mentions(&m.text).await;
            let body = format!("[Slack · {author}] {text}");

            let (iv, enc) = encrypt(&body).map_err(|e| {
                warn!(target: "worker", error = %e, "slack import encrypt failed");
                AppError::Internal("Failed to store imported message".into())
            })?;

            sqlx::query(
                "INSERT INTO channel_messages
                    (channel_id, sender_id, content_encrypted, content_iv)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(link.wayve_channel_id)
            .bind(importer_user_id)
            .bind(enc)
            .bind(iv)
            .execute(pool)
            .await?;

            newest_ts = Some(m.ts.clone());
            imported_here += 1;
        }

        if imported_here > 0 {
            sqlx::query("UPDATE slack_channel_links SET last_imported_ts = $1 WHERE id = $2")
                .bind(&newest_ts)
                .bind(link.id)
                .execute(pool)
                .await?;
            total_imported += imported_here;
            channels_touched += 1;
        }
    }

    info!(
        target: "worker",
        org_id = conn.organization_id, total_imported, channels_touched,
        "slack import complete"
    );
    Ok((total_imported, channels_touched))
}

/// Posts under the Wayve author's name rather than the bot's. Best-effort: logs
/// and swallows errors so it never fails its caller.
pub async fn push_to_slack_if_linked(
    pool: &PgPool,
    wayve_channel_id: i32,
    text: &str,
    sender_name: &str,
) {
    if let Err(e) = push_inner(pool, wayve_channel_id, text, sender_name).await {
        warn!(target: "worker", wayve_channel_id, error = %e, "slack outbound push failed");
    }
}

async fn push_inner(
    pool: &PgPool,
    wayve_channel_id: i32,
    text: &str,
    sender_name: &str,
) -> Result<(), AppError> {
    let Some(row) = sqlx::query(
        "SELECT slack_channel_id, organization_id
           FROM slack_channel_links WHERE wayve_channel_id = $1",
    )
    .bind(wayve_channel_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(());
    };
    let slack_channel_id: String = row.get("slack_channel_id");
    let org_id: i32 = row.get("organization_id");

    let Some(conn) = super::handler::load_connection(pool, org_id).await? else {
        return Ok(());
    };
    if !conn.enabled {
        return Ok(());
    }
    SlackClient::new(&conn)
        .post_message(&slack_channel_id, text, Some(sender_name))
        .await
}
