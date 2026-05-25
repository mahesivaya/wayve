use crate::prelude::*;

// ================= MODEL =================
#[derive(Clone, Serialize, FromRow)]
pub struct Meeting {
    pub id: i32,
    pub title: String,
    pub date: NaiveDate,
    pub start_time: NaiveTime,
    pub end_time: NaiveTime,
    pub participants: Vec<String>,
    pub zoom_join_url: Option<String>,
    pub source: String,
}

// ================= INPUT =================
#[derive(Deserialize)]
pub struct CreateMeeting {
    pub title: String,
    pub date: String,
    pub start: i32,
    pub end: i32,
    pub participants: Vec<String>,
    /// IANA timezone of the client (e.g. "Asia/Kolkata"). Used to interpret
    /// `date` + `start` as a wall-clock time in that zone for the past check.
    pub tz: Option<String>,
}
