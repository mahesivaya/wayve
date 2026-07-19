// Meeting invites must reach participants even when the organizer has no Gmail
// connected. That was the production failure: invites went out ONLY through the
// organizer's Gmail OAuth token, so every local-auth user silently notified
// nobody while the API still reported success.
#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use chrono::{NaiveDate, NaiveTime};
    use std::sync::Mutex;

    use crate::scheduler::email_notifications::{
        MeetingEmailKind, MeetingEmailRequest, send_meeting_emails_with,
    };
    use crate::scheduler::mail_delivery::{RawMailMessage, RawMailSender, build_meeting_content};
    use crate::test_support::{insert_local_user, random_email, test_pool};

    fn date() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 5, 26).unwrap_or_else(|| panic!("valid date"))
    }

    fn t(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).unwrap_or_else(|| panic!("valid time"))
    }

    /// Records whether the Gmail path was attempted, and can force a failure to
    /// exercise the fallback-on-error branch.
    struct SpySender {
        calls: Mutex<usize>,
        fail: bool,
    }

    #[async_trait]
    impl RawMailSender for SpySender {
        async fn send(
            &self,
            _access_token: &str,
            _message: &RawMailMessage,
        ) -> Result<(), crate::scheduler::email_notifications::MeetingEmailError> {
            if let Ok(mut c) = self.calls.lock() {
                *c += 1;
            }
            if self.fail {
                return Err(
                    crate::scheduler::email_notifications::MeetingEmailError::GmailStatus(
                        "token expired".into(),
                    ),
                );
            }
            Ok(())
        }
    }

    fn request(user_id: i32, participants: Vec<String>) -> MeetingEmailRequest {
        MeetingEmailRequest {
            user_id,
            participants,
            title: "Quarterly Review".into(),
            date: date(),
            start: t(10, 0),
            end: t(11, 0),
            kind: MeetingEmailKind::Invite,
            zoom_join_url: Some("https://zoom.example/j/1".into()),
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn falls_back_to_smtp_when_the_organizer_has_no_gmail_account() {
        let pool = test_pool().await;
        // A local-auth user, i.e. no row in email_accounts — exactly the
        // production case (user 90, mahesh@fluxze.com).
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;

        let spy = SpySender {
            calls: Mutex::new(0),
            fail: false,
        };
        let res = send_meeting_emails_with(
            &pool,
            &spy,
            request(user_id, vec!["participant@example.com".into()]),
        )
        .await;

        // The Gmail sender must not even be attempted — there's no token.
        assert_eq!(*spy.calls.lock().unwrap_or_else(|e| e.into_inner()), 0);

        // Without SMTP configured in the test env this reports SmtpFailed
        // rather than NoActiveAccount: the point is that delivery was ATTEMPTED
        // over SMTP instead of abandoned. With SMTP configured it succeeds; the
        // Mailpit-backed check covers that path.
        match res {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("SMTP failed"),
                    "expected an SMTP attempt, got: {msg}"
                );
            }
        }
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn rejects_a_meeting_with_no_usable_participants() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;

        let spy = SpySender {
            calls: Mutex::new(0),
            fail: false,
        };
        let res = send_meeting_emails_with(
            &pool,
            &spy,
            request(user_id, vec!["not-an-address".into(), "".into()]),
        )
        .await;

        assert!(res.is_err(), "garbage participants must not be sent to");
        assert_eq!(*spy.calls.lock().unwrap_or_else(|e| e.into_inner()), 0);
    }

    #[test]
    fn both_transports_share_one_message_body() {
        // Guards against the two send paths drifting into different wording.
        let (subject, body) = build_meeting_content(
            "Quarterly Review",
            date(),
            t(10, 0),
            t(11, 0),
            MeetingEmailKind::Invite,
            Some("https://zoom.example/j/1"),
        );
        assert_eq!(subject, "Meeting: Quarterly Review");
        assert!(body.contains("Quarterly Review"));
        assert!(body.contains("2026-05-26"));
        assert!(body.contains("10:00"));
        assert!(body.contains("11:00"));
        assert!(
            body.contains("https://zoom.example/j/1"),
            "the join link is the whole point of the invite"
        );
    }
}
