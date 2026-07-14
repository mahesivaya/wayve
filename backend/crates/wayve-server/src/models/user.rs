use crate::prelude::*;
use chrono::{DateTime, Utc};

#[derive(FromRow)]
pub struct User {
    pub id: i32,
    pub email: String,
    pub password: Option<String>,
    pub account_type: String,
    /// Hard expiry on the password, null for accounts that never expire. Once
    /// past, login is rejected even when bcrypt verify passes; while future, the
    /// issued JWT's `exp` is clamped so it cannot outlive this value.
    pub password_valid_until: Option<DateTime<Utc>>,
}
