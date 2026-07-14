use crate::prelude::*;
use chrono::{DateTime, Utc};
use sqlx::Type;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Type)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Sent,
    Delivered,
    Read,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Message {
    pub message_id: Option<i32>,
    pub sender_id: i32,
    pub receiver_id: i32,
    pub content: String,
    pub status: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    /// Grouped by emoji and filled in by the history handler after the rows are
    /// read; empty for a message nobody has reacted to.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[sqlx(skip)]
    pub reactions: Vec<crate::chat::reactions::ReactionGroup>,
}

#[derive(Serialize)]
pub struct MessageResponse {
    pub message: String,
}

/// The chat WebSocket wire format; must stay in sync with the frontend's
/// `src/chat` sender.
#[derive(Serialize, Deserialize)]
pub struct ChatMessage {
    pub sender_id: i32,
    pub receiver_id: Option<i32>,
    pub channel_id: Option<i32>,
    /// A client E2E envelope, not plaintext, for every normal message from a
    /// non-enterprise sender; the WebSocket rejects plaintext from them.
    pub content: String,
    pub status: Option<MessageStatus>,
    pub message_id: Option<i32>,
    // Set only on threaded channel replies, whose parent must live in the same
    // channel. Threads are channel-only, so this is always None on a direct
    // message.
    #[serde(default)]
    pub parent_message_id: Option<i32>,
    // Sender-generated correlation token, echoed in the broadcast so the sender
    // can match the server-assigned `message_id` to its optimistic local copy.
    #[serde(default)]
    pub client_id: Option<String>,
    // chat_attachments ids to link to this message, whether a direct message or
    // a channel message.
    #[serde(default)]
    pub attachment_ids: Vec<i64>,
}
