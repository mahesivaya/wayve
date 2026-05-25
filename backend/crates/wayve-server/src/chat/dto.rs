use serde::Deserialize;

#[derive(Deserialize)]
pub struct QueryParams {
    pub user1: i32,
    pub user2: i32,
}

#[derive(Deserialize)]
pub struct CreateChannelInput {
    pub name: String,
    pub member_ids: Option<Vec<i32>>,
    pub invite_emails: Option<Vec<String>>,
    pub invite_role: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateChannelSubjectInput {
    pub name: String,
}

#[derive(Deserialize)]
pub struct UpdateChannelVisibilityInput {
    pub visibility: String,
}

#[derive(Deserialize)]
pub struct AddChannelUsersInput {
    pub invite_emails: Vec<String>,
    pub invite_role: Option<String>,
}

#[derive(Deserialize)]
pub struct RemoveChannelUserInput {
    pub email: String,
}

#[derive(Deserialize)]
pub struct JoinRequestActionInput {
    pub user_id: i32,
}

#[derive(Deserialize)]
pub struct ChannelMessagesQuery {
    pub channel_id: i32,
}

#[derive(Deserialize)]
pub struct WsAuthQuery {
    pub token: Option<String>,
}
