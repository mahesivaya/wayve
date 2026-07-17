use crate::prelude::*;

#[derive(Serialize, FromRow)]
pub struct Reminder {
    pub id: i32,
    pub title: String,
    pub notes: Option<String>,
    pub remind_at: NaiveDateTime,
    pub created_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
pub struct ReminderInput {
    pub title: String,
    pub notes: Option<String>,
    // Local wall-clock time "YYYY-MM-DDTHH:MM(:SS)" — parsed as a naive datetime,
    // matching how the scheduler stores meeting times.
    pub remind_at: String,
}
