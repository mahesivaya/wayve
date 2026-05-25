use crate::prelude::*;

#[derive(FromRow)]
pub struct User {
    pub id: i32,
    pub email: String,
    pub password: Option<String>,
    pub account_type: String,
}
