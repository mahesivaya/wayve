use crate::prelude::*;

#[derive(Serialize, FromRow)]
pub struct Task {
    pub id: i32,
    pub name: String,
    pub description: String,
    pub priority: i16,
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
pub struct TaskInput {
    pub name: String,
    pub description: Option<String>,
    pub priority: Option<i16>,
}
