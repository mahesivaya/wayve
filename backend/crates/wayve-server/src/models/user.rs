use crate::prelude::*;
use chrono::{DateTime, Utc};

#[derive(FromRow)]
pub struct User {
    pub id: i32,
    pub email: String,
    pub password: Option<String>,
    pub account_type: String,
    /// Optional hard expiry on the password. NULL = the account never
    /// expires (every user not provisioned as a guest is in this
    /// bucket). When set to a past time, the login handler rejects
    /// the credential even if bcrypt verify passes. When set to a
    /// future time, the issued JWT's `exp` is clamped so it can't
    /// outlive this value.
    pub password_valid_until: Option<DateTime<Utc>>,
}
