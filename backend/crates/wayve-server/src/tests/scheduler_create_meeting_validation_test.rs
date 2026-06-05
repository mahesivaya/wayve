#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeZone, Utc};

    use crate::models::scheduler::CreateMeeting;
    use crate::scheduler::create_meeting::{CreateMeetingValidationError, validate_create_meeting};

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 5, 26, 12, 0, 0)
            .single()
            .unwrap_or_else(|| panic!("valid now"))
    }

    // Minutes since midnight, matching the CreateMeeting wire shape.
    fn min(h: i32, m: i32) -> i32 {
        h * 60 + m
    }

    fn base() -> CreateMeeting {
        CreateMeeting {
            title: "Standup".into(),
            // Tomorrow vs `now()`, so the past-check passes by default.
            date: "2026-05-27".into(),
            start: min(9, 0),
            end: min(9, 30),
            participants: vec![],
            tz: Some("UTC".into()),
        }
    }

    #[test]
    fn rejects_empty_title() {
        let mut raw = base();
        raw.title = "   ".into();
        let err = validate_create_meeting(&raw, now()).expect_err("should reject empty title");
        assert_eq!(err, CreateMeetingValidationError::TitleRequired);
    }

    #[test]
    fn rejects_inverted_time_range() {
        let mut raw = base();
        raw.start = min(10, 0);
        raw.end = min(9, 0);
        let err = validate_create_meeting(&raw, now()).expect_err("should reject inverted range");
        assert_eq!(err, CreateMeetingValidationError::InvalidTimeRange);
    }

    #[test]
    fn rejects_equal_start_and_end() {
        let mut raw = base();
        raw.start = min(9, 0);
        raw.end = min(9, 0);
        let err = validate_create_meeting(&raw, now()).expect_err("should reject zero duration");
        assert_eq!(err, CreateMeetingValidationError::InvalidTimeRange);
    }

    #[test]
    fn rejects_unparseable_date() {
        let mut raw = base();
        raw.date = "27/05/2026".into();
        let err = validate_create_meeting(&raw, now()).expect_err("should reject bad date");
        assert_eq!(err, CreateMeetingValidationError::InvalidDate);
    }

    #[test]
    fn rejects_meeting_in_past() {
        let mut raw = base();
        raw.date = "2026-05-25".into();
        let err = validate_create_meeting(&raw, now()).expect_err("should reject past meeting");
        assert_eq!(err, CreateMeetingValidationError::MeetingInPast);
    }

    #[test]
    fn meeting_equal_to_now_is_in_past() {
        // The handler's original check is `meeting_utc <= now`; pin that.
        let mut raw = base();
        raw.date = "2026-05-26".into();
        raw.start = min(12, 0);
        raw.end = min(13, 0);
        let err = validate_create_meeting(&raw, now()).expect_err("equal-to-now is past");
        assert_eq!(err, CreateMeetingValidationError::MeetingInPast);
    }

    #[test]
    fn missing_tz_falls_back_to_utc() {
        let mut raw = base();
        raw.tz = None;
        let ok = validate_create_meeting(&raw, now())
            .unwrap_or_else(|err| panic!("expected Ok: {err:?}"));
        assert_eq!(
            ok.meeting_utc,
            Utc.with_ymd_and_hms(2026, 5, 27, 9, 0, 0)
                .single()
                .unwrap_or_else(|| panic!("valid utc"))
        );
    }

    #[test]
    fn unparseable_tz_falls_back_to_utc() {
        let mut raw = base();
        raw.tz = Some("Not/A/Zone".into());
        let ok = validate_create_meeting(&raw, now()).unwrap_or_else(|err| panic!("Ok: {err:?}"));
        assert_eq!(
            ok.meeting_utc,
            Utc.with_ymd_and_hms(2026, 5, 27, 9, 0, 0)
                .single()
                .unwrap_or_else(|| panic!("valid utc"))
        );
    }

    #[test]
    fn tz_offset_applied_when_parseable() {
        let mut raw = base();
        // 09:00 in Asia/Kolkata (UTC+5:30) on 2026-05-27 → 03:30 UTC.
        raw.tz = Some("Asia/Kolkata".into());
        let ok = validate_create_meeting(&raw, now()).unwrap_or_else(|err| panic!("Ok: {err:?}"));
        assert_eq!(
            ok.meeting_utc,
            Utc.with_ymd_and_hms(2026, 5, 27, 3, 30, 0)
                .single()
                .unwrap_or_else(|| panic!("valid utc"))
        );
    }

    #[test]
    fn filters_bad_participants_silently() {
        let mut raw = base();
        raw.participants = vec![
            "  ALICE@example.com ".into(),
            "no-at-sign".into(),
            "missing-dot@invalid".into(),
            "bob@example.org".into(),
            "".into(),
        ];
        let ok = validate_create_meeting(&raw, now()).unwrap_or_else(|err| panic!("Ok: {err:?}"));
        assert_eq!(
            ok.participants,
            vec!["alice@example.com", "bob@example.org"]
        );
    }

    #[test]
    fn duration_min_matches_end_minus_start() {
        let mut raw = base();
        raw.start = min(9, 0);
        raw.end = min(10, 45);
        let ok = validate_create_meeting(&raw, now()).unwrap_or_else(|err| panic!("Ok: {err:?}"));
        assert_eq!(ok.duration_min, 105);
    }

    #[test]
    fn error_messages_match_original_handler_responses() {
        // The handler used these exact 400-body strings before the refactor;
        // pin them so the public error surface doesn't drift.
        assert_eq!(
            CreateMeetingValidationError::TitleRequired.message(),
            "Title is required"
        );
        assert_eq!(
            CreateMeetingValidationError::InvalidTimeRange.message(),
            "Invalid time range"
        );
        assert_eq!(
            CreateMeetingValidationError::InvalidDate.message(),
            "Invalid date"
        );
        assert_eq!(
            CreateMeetingValidationError::InvalidDateTime.message(),
            "Invalid date/time"
        );
        assert_eq!(
            CreateMeetingValidationError::MeetingInPast.message(),
            "Meeting cannot be in the past"
        );
    }
}
