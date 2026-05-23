use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct RegisterInput {
    pub email: String,
    pub password: String,
    pub confirm_password: String,
    /// Recovery-phrase mode chosen at signup: "full" (server escrows a
    /// wrapped private key so a new device can restore encrypted history)
    /// or "password_only" (server only stores a credential blob for
    /// mnemonic-based password reset; new devices start with fresh keys
    /// and cannot decrypt history). Defaults to "full" when omitted so
    /// older clients that don't send the field keep working.
    #[serde(default)]
    pub recovery_mode: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginInput {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub account_type: String,
}

#[derive(Deserialize)]
pub struct ForgotInput {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ResetInput {
    pub token: String,
    pub new_password: String,
}

#[derive(Deserialize)]
pub struct ChangePasswordInput {
    pub current_password: Option<String>,
    pub new_password: String,
}
