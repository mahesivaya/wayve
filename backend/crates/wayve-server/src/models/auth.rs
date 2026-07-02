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
    /// Server-provisioned login wrap for org members. Personal users get
    /// `None` — they use the client-side keypair + mnemonic recovery
    /// path. Org members use this to unwrap their PKCS8 private key with
    /// PBKDF2(password) on first-login or any fresh device.
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
    /// Org members MUST send this — their private key is wrapped under
    /// PBKDF2(password) in member_login_wrapped_keys, and changing the
    /// password without rotating the wrap would lock them out on next
    /// login. Frontend computes this in-browser using PBKDF2(new_password)
    /// over the same plaintext PKCS8 it just unwrapped with old_password.
    /// Personal users (no member_login_wrapped_keys row) leave this None.
    pub new_login_wrap: Option<NewLoginWrapInput>,
}

#[derive(Deserialize)]
pub struct NewLoginWrapInput {
    pub iv: String,
    pub ct: String,
    pub salt: String,
    pub iterations: i32,
}
