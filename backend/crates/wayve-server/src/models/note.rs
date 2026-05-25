use crate::prelude::*;

#[derive(Serialize, FromRow)]
pub struct Note {
    pub id: i32,
    pub title: Option<String>,
    pub content: Option<String>,
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
pub struct NoteInput {
    pub title: Option<String>,
    pub content: Option<String>,
}
