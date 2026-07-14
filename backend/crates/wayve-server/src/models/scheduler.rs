use crate::prelude::*;

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

#[derive(Deserialize)]
pub struct CreateMeeting {
    pub title: String,
    pub date: String,
    pub start: i32,
    pub end: i32,
    pub participants: Vec<String>,
    /// The client's IANA timezone, used to read `date` and `start` as wall-clock
    /// time in that zone when checking whether the meeting is in the past.
    pub tz: Option<String>,
}
