//! Emoji reactions on chat messages.
//!
//! Reactions ride the chat WebSocket: a `react` frame in, a `reaction_updated`
//! frame out to every participant carrying the message's full re-aggregated
//! reaction set rather than a delta, so a client that missed a frame converges.
//!
//! The emoji is stored in plaintext, unlike message content, which is a client
//! E2E envelope the server cannot read. Reactions must be aggregated server-side,
//! and the per-recipient key wrapping means a reactor cannot produce an
//! aggregatable ciphertext. See `message_reactions` in `infra/postgres/init.sql`.

use crate::cache::Cache;
use crate::prelude::*;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use tracing::warn;

use super::websocket::fan_out_user;

/// Roomy enough for a multi-codepoint ZWJ sequence. The cap is what stops this
/// plaintext field from smuggling a message body past the E2E check.
const MAX_EMOJI_LEN: usize = 32;

/// Inbound `{"type":"react", …}` frame. Other chat frames carry no `type` field,
/// so they fail to deserialize here, which is how the WS handler tells them apart.
#[derive(Debug, Deserialize)]
pub struct ReactionFrame {
    pub r#type: String,
    /// Id of the message reacted to, in whichever table `is_channel` selects.
    pub message_id: i32,
    /// True selects `channel_messages`, false selects `messages` (DMs). The two
    /// tables have independent id spaces, so an id alone is ambiguous.
    #[serde(default)]
    pub is_channel: bool,
    pub emoji: String,
}

/// One emoji and everyone who reacted with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionGroup {
    pub emoji: String,
    pub user_ids: Vec<i32>,
}

/// Oldest emoji first, so the pills do not reshuffle as counts change.
async fn grouped_for_message(
    pool: &PgPool,
    message_id: i32,
    is_channel: bool,
) -> Result<Vec<ReactionGroup>, sqlx::Error> {
    let column = if is_channel {
        "channel_message_id"
    } else {
        "message_id"
    };
    // `column` is one of the two literals chosen above, never client input.
    let sql = format!(
        "SELECT emoji, ARRAY_AGG(user_id ORDER BY user_id) AS user_ids \
         FROM message_reactions \
         WHERE {column} = $1 \
         GROUP BY emoji \
         ORDER BY MIN(created_at), emoji"
    );
    let rows = sqlx::query(&sql).bind(message_id).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|r| ReactionGroup {
            emoji: r.get("emoji"),
            user_ids: r.get("user_ids"),
        })
        .collect())
}

/// One query per page of history instead of one per message.
pub async fn grouped_for_messages(
    pool: &PgPool,
    message_ids: &[i32],
    is_channel: bool,
) -> HashMap<i32, Vec<ReactionGroup>> {
    if message_ids.is_empty() {
        return HashMap::new();
    }
    let column = if is_channel {
        "channel_message_id"
    } else {
        "message_id"
    };
    let sql = format!(
        "SELECT {column} AS mid, emoji, ARRAY_AGG(user_id ORDER BY user_id) AS user_ids \
         FROM message_reactions \
         WHERE {column} = ANY($1) \
         GROUP BY {column}, emoji \
         ORDER BY MIN(created_at), emoji"
    );
    let rows = match sqlx::query(&sql).bind(message_ids).fetch_all(pool).await {
        Ok(rows) => rows,
        Err(e) => {
            // Reactions are decoration, so a failure here degrades to "none"
            // rather than blanking out the message history.
            warn!(target: "ws", error = ?e, "reaction fetch failed; serving messages without reactions");
            return HashMap::new();
        }
    };

    let mut out: HashMap<i32, Vec<ReactionGroup>> = HashMap::new();
    for row in rows {
        let mid: i32 = row.get("mid");
        out.entry(mid).or_default().push(ReactionGroup {
            emoji: row.get("emoji"),
            user_ids: row.get("user_ids"),
        });
    }
    out
}

/// Attach a `reactions` array to each already-built message object. The caller
/// has already authorized the read, so this runs on the plain pool.
pub async fn attach_to_json(pool: &PgPool, messages: &mut [serde_json::Value], is_channel: bool) {
    let ids: Vec<i32> = messages
        .iter()
        .filter_map(|m| m.get("message_id").and_then(|v| v.as_i64()))
        .map(|v| v as i32)
        .collect();

    let by_message = grouped_for_messages(pool, &ids, is_channel).await;

    for msg in messages.iter_mut() {
        let Some(id) = msg
            .get("message_id")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
        else {
            continue;
        };
        let groups = by_message.get(&id).map(Vec::as_slice).unwrap_or(&[]);
        let value = serde_json::to_value(groups).unwrap_or_else(|_| serde_json::json!([]));
        if let Some(obj) = msg.as_object_mut() {
            obj.insert("reactions".to_string(), value);
        }
    }
}

/// Who to notify about a reaction change, and in the same pass whether `actor_id`
/// may react at all. `RowNotFound` means no such message, or a non-participant.
async fn audience(
    pool: &PgPool,
    actor_id: i32,
    message_id: i32,
    is_channel: bool,
) -> Result<(Vec<i32>, Option<i32>), sqlx::Error> {
    if is_channel {
        // Derive the channel from the message rather than trusting a
        // client-supplied id, then gate on membership of that channel.
        let channel_id =
            sqlx::query_scalar::<_, i32>("SELECT channel_id FROM channel_messages WHERE id = $1")
                .bind(message_id)
                .fetch_optional(pool)
                .await?
                .ok_or(sqlx::Error::RowNotFound)?;

        let members = sqlx::query_scalar::<_, i32>(
            "SELECT user_id FROM channel_members WHERE channel_id = $1",
        )
        .bind(channel_id)
        .fetch_all(pool)
        .await?;

        if !members.contains(&actor_id) {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok((members, Some(channel_id)))
    } else {
        let row = sqlx::query("SELECT sender_id, receiver_id FROM messages WHERE id = $1")
            .bind(message_id)
            .fetch_optional(pool)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        let sender: Option<i32> = row.get("sender_id");
        let receiver: Option<i32> = row.get("receiver_id");
        let participants: Vec<i32> = [sender, receiver].into_iter().flatten().collect();
        if !participants.contains(&actor_id) {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok((participants, None))
    }
}

/// Toggle `actor_id`'s reaction and broadcast the new set to every participant,
/// the actor included, so their pill reflects the server's view. Reacting with an
/// emoji you already used removes it, as the unique index on (message, user,
/// emoji) encodes.
pub async fn handle_react(
    pool: &PgPool,
    cache: &Option<Cache>,
    actor_id: i32,
    frame: ReactionFrame,
) {
    let emoji = frame.emoji.trim().to_string();
    if emoji.is_empty() || emoji.chars().count() > MAX_EMOJI_LEN {
        warn!(
            target: "ws",
            actor_id,
            len = emoji.chars().count(),
            "rejected reaction with empty or oversized emoji"
        );
        return;
    }

    let message_id = frame.message_id;
    let is_channel = frame.is_channel;

    let (recipients, channel_id) = match audience(pool, actor_id, message_id, is_channel).await {
        Ok(res) => res,
        Err(e) => {
            warn!(
                target: "ws",
                actor_id,
                message_id,
                is_channel,
                error = ?e,
                "rejected reaction on a message the actor cannot access"
            );
            return;
        }
    };

    let column = if is_channel {
        "channel_message_id"
    } else {
        "message_id"
    };

    // Toggle: delete first, insert only if there was nothing to delete.
    let delete_sql = format!(
        "DELETE FROM message_reactions \
         WHERE {column} = $1 AND user_id = $2 AND emoji = $3"
    );
    let removed = match sqlx::query(&delete_sql)
        .bind(message_id)
        .bind(actor_id)
        .bind(&emoji)
        .execute(pool)
        .await
    {
        Ok(res) => res.rows_affected() > 0,
        Err(e) => {
            warn!(target: "ws", actor_id, message_id, error = ?e, "reaction delete failed");
            return;
        }
    };

    if !removed {
        let insert_sql = format!(
            "INSERT INTO message_reactions ({column}, user_id, emoji) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING"
        );
        if let Err(e) = sqlx::query(&insert_sql)
            .bind(message_id)
            .bind(actor_id)
            .bind(&emoji)
            .execute(pool)
            .await
        {
            warn!(target: "ws", actor_id, message_id, error = ?e, "reaction insert failed");
            return;
        }
    }

    let reactions = match grouped_for_message(pool, message_id, is_channel).await {
        Ok(groups) => groups,
        Err(e) => {
            warn!(target: "ws", message_id, error = ?e, "reaction re-aggregation failed");
            return;
        }
    };

    let payload = serde_json::json!({
        "type": "reaction_updated",
        "message_id": message_id,
        "is_channel": is_channel,
        "channel_id": channel_id,
        "reactions": reactions,
    })
    .to_string();

    futures::future::join_all(recipients.into_iter().map(|user_id| {
        let payload = payload.clone();
        async move { fan_out_user(cache, user_id, payload).await }
    }))
    .await;
}
