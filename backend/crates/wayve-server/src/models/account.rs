use crate::prelude::*;

#[derive(Clone, serde::Serialize, FromRow)]
pub struct Account {
    id: i32,
    email: String,
    display_name: Option<String>,
    unread_count: i64,
    // Shared-inbox fields. `is_owner` separates mailboxes the user connected
    // themselves from ones they are only a member of, which gates Disconnect.
    #[serde(default)]
    is_shared: bool,
    #[serde(default)]
    shared_label: Option<String>,
    #[serde(default)]
    is_owner: bool,
}
