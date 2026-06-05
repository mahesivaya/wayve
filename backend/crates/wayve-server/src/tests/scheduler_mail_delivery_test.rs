#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, NaiveTime};

    use crate::scheduler::email_notifications::MeetingEmailKind;
    use crate::scheduler::mail_delivery::{
        build_meeting_message, decode_raw_message, filter_participants,
    };

    fn date() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 5, 26).expect("valid date")
    }

    fn t(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).expect("valid time")
    }

    #[test]
    fn filters_invalid_participants() {
        let input = vec![
            "  Alice@Example.COM ".to_string(),
            "no-at-sign".to_string(),
            "missing-dot@invalid".to_string(),
            "bob@example.org".to_string(),
            "".to_string(),
        ];
        let out = filter_participants(input);
        assert_eq!(out, vec!["alice@example.com", "bob@example.org"]);
    }

    #[test]
    fn invite_message_contains_required_fields() {
        let msg = build_meeting_message(
            "host@example.com",
            &[
                "alice@example.com".to_string(),
                "bob@example.org".to_string(),
            ],
            "Quarterly Review",
            date(),
            t(9, 30),
            t(10, 30),
            MeetingEmailKind::Invite,
            None,
        );
        let decoded = decode_raw_message(&msg);

        assert!(
            decoded.contains("From: host@example.com"),
            "from header missing"
        );
        assert!(
            decoded.contains("To: alice@example.com,bob@example.org"),
            "to header missing"
        );
        assert!(
            decoded.contains("Subject: Meeting: Quarterly Review"),
            "invite subject missing"
        );
        assert!(decoded.contains("Title: Quarterly Review"));
        assert!(decoded.contains("Date: 2026-05-26"));
        assert!(decoded.contains("Start: 09:30"));
        assert!(decoded.contains("End: 10:30"));
        assert!(decoded.contains("-- Wayve Scheduler"));
        assert!(!decoded.contains("Zoom:"), "no zoom line expected");
    }

    #[test]
    fn update_subject_differs_from_invite() {
        let msg = build_meeting_message(
            "host@example.com",
            &["alice@example.com".to_string()],
            "Standup",
            date(),
            t(9, 0),
            t(9, 15),
            MeetingEmailKind::Update,
            None,
        );
        let decoded = decode_raw_message(&msg);
        assert!(decoded.contains("Subject: Updated: Standup"));
    }

    #[test]
    fn cancel_subject_uses_cancelled_prefix() {
        let msg = build_meeting_message(
            "host@example.com",
            &["alice@example.com".to_string()],
            "Sync",
            date(),
            t(9, 0),
            t(9, 15),
            MeetingEmailKind::Cancel,
            None,
        );
        let decoded = decode_raw_message(&msg);
        assert!(decoded.contains("Subject: Cancelled: Sync"));
    }

    #[test]
    fn zoom_line_included_when_url_present() {
        let msg = build_meeting_message(
            "host@example.com",
            &["alice@example.com".to_string()],
            "Demo",
            date(),
            t(14, 0),
            t(15, 0),
            MeetingEmailKind::Invite,
            Some("https://zoom.us/j/123"),
        );
        let decoded = decode_raw_message(&msg);
        assert!(decoded.contains("Zoom: https://zoom.us/j/123"));
    }

    #[test]
    fn empty_zoom_url_treated_as_absent() {
        let msg = build_meeting_message(
            "host@example.com",
            &["alice@example.com".to_string()],
            "Demo",
            date(),
            t(14, 0),
            t(15, 0),
            MeetingEmailKind::Invite,
            Some(""),
        );
        let decoded = decode_raw_message(&msg);
        assert!(!decoded.contains("Zoom:"));
    }
}
