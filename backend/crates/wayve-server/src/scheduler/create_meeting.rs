// Pure validation for the POST /meetings body, kept apart from `create_meeting`
// so it is testable without a DB, HTTP, or a clock.

use crate::models::scheduler::CreateMeeting;
use crate::scheduler::time::minutes_to_time;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use std::str::FromStr;

#[derive(Debug, PartialEq, Eq)]
pub enum CreateMeetingValidationError {
    TitleRequired,
    InvalidTimeRange,
    InvalidDate,
    InvalidDateTime,
    MeetingInPast,
}

impl CreateMeetingValidationError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::TitleRequired => "Title is required",
            Self::InvalidTimeRange => "Invalid time range",
            Self::InvalidDate => "Invalid date",
            Self::InvalidDateTime => "Invalid date/time",
            Self::MeetingInPast => "Meeting cannot be in the past",
        }
    }
}

#[derive(Debug)]
pub struct ValidatedMeetingInput {
    pub title: String,
    pub participants: Vec<String>,
    pub date: NaiveDate,
    pub start_time: NaiveTime,
    pub end_time: NaiveTime,
    pub meeting_utc: DateTime<Utc>,
    pub duration_min: i64,
}

pub fn validate_create_meeting(
    raw: &CreateMeeting,
    now: DateTime<Utc>,
) -> Result<ValidatedMeetingInput, CreateMeetingValidationError> {
    if raw.title.trim().is_empty() {
        return Err(CreateMeetingValidationError::TitleRequired);
    }

    // Participants are optional, and garbage entries are filtered out silently
    // rather than rejecting the whole request.
    let participants: Vec<String> = raw
        .participants
        .iter()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| e.contains('@') && e.contains('.'))
        .collect();

    let start_time = minutes_to_time(raw.start);
    let end_time = minutes_to_time(raw.end);
    if start_time >= end_time {
        return Err(CreateMeetingValidationError::InvalidTimeRange);
    }

    let date = NaiveDate::parse_from_str(&raw.date, "%Y-%m-%d")
        .map_err(|_| CreateMeetingValidationError::InvalidDate)?;

    // Default to UTC on a missing or unparseable timezone: a neutral fallback
    // will not spuriously reject a future meeting the way a hardcoded zone can.
    let tz: Tz = raw
        .tz
        .as_deref()
        .and_then(|s| Tz::from_str(s).ok())
        .unwrap_or(Tz::UTC);

    let naive = NaiveDateTime::new(date, start_time);
    let meeting_utc = tz
        .from_local_datetime(&naive)
        .single()
        .ok_or(CreateMeetingValidationError::InvalidDateTime)?
        .with_timezone(&Utc);

    if meeting_utc <= now {
        return Err(CreateMeetingValidationError::MeetingInPast);
    }

    let duration_min = (end_time - start_time).num_minutes();

    Ok(ValidatedMeetingInput {
        title: raw.title.clone(),
        participants,
        date,
        start_time,
        end_time,
        meeting_utc,
        duration_min,
    })
}
