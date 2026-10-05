use crate::routes::auth_scheme::DerivedCredential;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct RegisterInput {
    pub email: String,
    /// Legacy raw password (scheme 1). The web app sends `credential` instead.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub confirm_password: Option<String>,
    /// Browser-derived credential (scheme 2); the password never reaches us.
    #[serde(default)]
    pub credential: Option<DerivedCredential>,
    /// Recovery mode chosen at signup. "full" escrows a wrapped private key so a
    /// new device can restore encrypted history; "password_only" stores only a
    /// credential blob for mnemonic password reset, and new devices start with
    /// fresh keys that cannot decrypt history. Defaults to "full" so older
    /// clients that omit the field keep working.
    #[serde(default)]
    pub recovery_mode: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginInput {
    pub email: String,
    /// Scheme-1 accounts only. Never accepted for a scheme-2 account.
    #[serde(default)]
    pub password: Option<String>,
    /// Scheme-2 proof: PBKDF2 of the password under the account's `auth_salt`.
    #[serde(default)]
    pub auth_key: Option<String>,
    /// Sent with a scheme-1 `password` to move the account to scheme 2 in the
    /// same request — the last time the server sees that password.
    #[serde(default)]
    pub upgrade: Option<DerivedCredential>,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub account_type: String,
    /// Server-provisioned login wrap that org members use to unwrap their PKCS8
    /// private key with PBKDF2(password) on a fresh device. `None` for personal
    /// users, who use the client keypair and mnemonic recovery path instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_wrap: Option<MemberLoginWrap>,
}

#[derive(Serialize)]
pub struct MemberLoginWrap {
    pub iv: String,
    pub ct: String,
    pub salt: String,
    pub iterations: i32,
}

#[derive(Deserialize)]
pub struct ForgotInput {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ResetInput {
    pub token: String,
    #[serde(default)]
    pub new_password: Option<String>,
    #[serde(default)]
    pub new_credential: Option<DerivedCredential>,
}

#[derive(Deserialize)]
pub struct VerifyEmailInput {
    pub email: String,
    pub code: String,
}

#[derive(Deserialize)]
pub struct ResendVerificationInput {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ChangePasswordInput {
    /// Current-password proof for a scheme-1 account.
    pub current_password: Option<String>,
    /// Current-password proof for a scheme-2 account.
    #[serde(default)]
    pub current_auth_key: Option<String>,
    #[serde(default)]
    pub new_password: Option<String>,
    #[serde(default)]
    pub new_credential: Option<DerivedCredential>,
    /// Org members must send this: their private key is wrapped under
    /// PBKDF2(password) in member_login_wrapped_keys, so changing the password
    /// without rotating the wrap locks them out at the next login. Personal
    /// users, who have no such row, leave it None.
    pub new_login_wrap: Option<NewLoginWrapInput>,
}

#[derive(Deserialize)]
pub struct NewLoginWrapInput {
    pub iv: String,
    pub ct: String,
    pub salt: String,
    pub iterations: i32,
}
