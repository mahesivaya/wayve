use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct RegisterInput {
    pub email: String,
    pub password: String,
    pub confirm_password: String,
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
    pub password: String,
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
    pub new_password: String,
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
    pub current_password: Option<String>,
    pub new_password: String,
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
