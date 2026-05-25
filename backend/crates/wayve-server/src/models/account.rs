use crate::prelude::*;

#[derive(Clone, serde::Serialize, FromRow)]
pub struct Account {
    id: i32,
    email: String,
    display_name: Option<String>,
    unread_count: i64,
    // Shared-inbox surface. `is_shared` lights up the chip in the
    // sidebar; `shared_label` is the friendly name ("Support"); and
    // `is_owner` distinguishes mailboxes the user themselves connected
    // from ones they're a member of (controls "Disconnect" visibility,
    // etc.).
    #[serde(default)]
    is_shared: bool,
    #[serde(default)]
    shared_label: Option<String>,
    #[serde(default)]
    is_owner: bool,
}
