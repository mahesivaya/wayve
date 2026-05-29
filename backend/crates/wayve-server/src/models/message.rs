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
}
//
#[derive(Serialize)]
pub struct MessageResponse {
    pub message: String,
}

//

#[derive(Serialize, Deserialize)]
pub struct ChatMessage {
    pub sender_id: i32,
    pub receiver_id: Option<i32>,
    pub channel_id: Option<i32>,
    pub content: String,
    pub status: Option<MessageStatus>,
    pub message_id: Option<i32>,
    // Set for threaded channel replies; the parent must live in the same
    // channel. None for top-level messages and all direct messages (threads
    // are channel-only).
    #[serde(default)]
    pub parent_message_id: Option<i32>,
    // Sender-generated correlation token. Echoed in the broadcast JSON so
    // the sender's client can match the server-assigned `message_id` back to
    // its optimistic local copy without a full re-fetch. None for legacy
    // clients and for rows fetched from history.
    #[serde(default)]
    pub client_id: Option<String>,
}
