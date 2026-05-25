use crate::prelude::*;

#[derive(Debug, Deserialize)]
pub struct SendEmailRequest {
    pub account_id: i32,
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct UserResponse {
    pub id: i32,
    pub email: String,
    pub public_key: Option<String>,
}
