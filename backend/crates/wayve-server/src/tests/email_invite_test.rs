// Meeting invitations. The list flags them (`is_invite`: a calendar
// attachment, or Outlook's meeting-message label), sync keeps a calendar part
// with no file name, and `GET /emails/{id}/invite` reads the meeting for the
// card: from Gmail's calendar part, inline or attached, or from Outlook's
// event (both mocked here).
#[cfg(test)]
mod tests {
    use crate::email::invite::{gmail_invite, outlook_event_invite, outlook_invite};
    use crate::email::repo::{self, EmailListFilters};
    use crate::email::utils::extract_attachments;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use sqlx::PgPool;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const ICS: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261020T150000Z\r\n\
DTEND:20261020T153000Z\r\nSUMMARY:Design review\r\nORGANIZER;CN=Ada:mailto:ada@x.com\r\n\
END:VEVENT\r\nEND:VCALENDAR\r\n";

    #[actix_web::test]
    #[serial_test::serial]
    async fn reads_gmails_inline_calendar_part_and_its_method() {
        let mock = MockServer::start().await;
        // No METHOD line in the body: it is only on the part's Content-Type.
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/m1"))
            .and(query_param("format", "full"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "payload": {
                    "mimeType": "multipart/mixed",
                    "parts": [
                        { "mimeType": "multipart/alternative", "parts": [
                            { "mimeType": "text/plain", "body": { "data": URL_SAFE_NO_PAD.encode("hi") } },
                            { "mimeType": "text/calendar",
                              "headers": [{ "name": "Content-Type",
                                            "value": "text/calendar; charset=\"UTF-8\"; method=REQUEST" }],
                              "body": { "data": URL_SAFE_NO_PAD.encode(ICS) } }
                        ]}
                    ]
                }
            })))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };
        let invite = gmail_invite("tok", "m1").await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };

        let invite = invite
            .unwrap_or_else(|e| panic!("read: {e}"))
            .unwrap_or_else(|| panic!("no invite"));
        assert_eq!(invite.title.as_deref(), Some("Design review"));
        assert_eq!(invite.method.as_deref(), Some("request"));
        assert_eq!(invite.organizer_email.as_deref(), Some("ada@x.com"));
        assert_eq!(
            invite.start.map(|t| t.to_rfc3339()),
            Some("2026-10-20T15:00:00+00:00".into())
        );
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn reads_an_attached_ics_and_finds_none_in_a_plain_email() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/m2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "payload": { "mimeType": "multipart/mixed", "parts": [
                    { "mimeType": "application/octet-stream", "filename": "invite.ics",
                      "body": { "attachmentId": "att1" } }
                ]}
            })))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/m2/attachments/att1"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "data": URL_SAFE_NO_PAD.encode(ICS) })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/plain"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "payload": { "mimeType": "text/plain", "body": { "data": "aGk" } }
            })))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("GMAIL_API_BASE", mock.uri()) };
        let attached = gmail_invite("tok", "m2").await;
        let plain = gmail_invite("tok", "plain").await;
        unsafe { std::env::remove_var("GMAIL_API_BASE") };

        let attached = attached
            .unwrap_or_else(|e| panic!("read: {e}"))
            .unwrap_or_else(|| panic!("no invite"));
        assert_eq!(attached.title.as_deref(), Some("Design review"));
        assert_eq!(plain.unwrap_or_else(|e| panic!("read: {e}")), None);
    }

    #[test]
    fn maps_an_outlook_meeting_message() {
        let message = serde_json::json!({
            "subject": "Fallback subject",
            "meetingMessageType": "meetingCancelled",
            "event": {
                "subject": "Budget sync",
                "isAllDay": false,
                "isCancelled": true,
                "start": { "dateTime": "2026-10-20T15:00:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-10-20T16:00:00.0000000", "timeZone": "UTC" },
                "location": { "displayName": "Room 2" },
                "organizer": { "emailAddress": { "name": "Bo", "address": "bo@x.com" } },
                "onlineMeeting": { "joinUrl": "https://teams.microsoft.com/l/meetup-join/1" }
            }
        });
        let invite = outlook_event_invite(&message).unwrap_or_else(|| panic!("no invite"));
        assert_eq!(invite.method.as_deref(), Some("cancel"));
        assert_eq!(invite.status.as_deref(), Some("cancelled"));
        assert_eq!(invite.title.as_deref(), Some("Budget sync"));
        assert_eq!(
            invite.start.map(|t| t.to_rfc3339()),
            Some("2026-10-20T15:00:00+00:00".into())
        );
        assert_eq!(
            invite.join_url.as_deref(),
            Some("https://teams.microsoft.com/l/meetup-join/1")
        );
        assert_eq!(invite.organizer_name.as_deref(), Some("Bo"));

        // An all-day event has dates, and a plain message has no event.
        let all_day = serde_json::json!({
            "meetingMessageType": "meetingRequest",
            "event": { "isAllDay": true,
                       "start": { "dateTime": "2026-10-24T00:00:00.0000000", "timeZone": "UTC" },
                       "end": { "dateTime": "2026-10-25T00:00:00.0000000", "timeZone": "UTC" } }
        });
        let invite = outlook_event_invite(&all_day).unwrap_or_else(|| panic!("no invite"));
        assert!(invite.all_day);
        assert_eq!(
            invite.start_date.map(|d| d.to_string()),
            Some("2026-10-24".into())
        );
        assert_eq!(
            outlook_event_invite(&serde_json::json!({ "subject": "Hi" })),
            None
        );
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn asks_outlook_for_the_message_with_its_event() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1.0/me/messages/AAMk1"))
            .and(query_param("$expand", "microsoft.graph.eventMessage/event"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "meetingMessageType": "meetingRequest",
                "event": { "subject": "Kickoff",
                           "start": { "dateTime": "2026-10-20T09:00:00", "timeZone": "UTC" } }
            })))
            .expect(1)
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe { std::env::set_var("MICROSOFT_GRAPH_BASE", mock.uri()) };
        let invite = outlook_invite("tok", "AAMk1").await;
        unsafe { std::env::remove_var("MICROSOFT_GRAPH_BASE") };
        let invite = invite
            .unwrap_or_else(|e| panic!("read: {e}"))
            .unwrap_or_else(|| panic!("no invite"));
        assert_eq!(invite.title.as_deref(), Some("Kickoff"));
        assert_eq!(invite.method.as_deref(), Some("request"));
    }

    #[test]
    fn sync_keeps_a_calendar_part_with_no_file_name() {
        let payload = serde_json::json!({
            "mimeType": "multipart/mixed",
            "parts": [
                { "mimeType": "text/calendar; method=REQUEST", "filename": "",
                  "body": { "attachmentId": "cal1", "size": 900 } },
                // An ordinary unnamed part is still not an attachment.
                { "mimeType": "text/plain", "filename": "", "body": { "attachmentId": "x" } }
            ]
        });
        let attachments = extract_attachments(&payload);
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].filename, "invite.ics");
        assert_eq!(attachments[0].attachment_id, "cal1");
    }

    async fn mailbox(pool: &PgPool) -> (i32, String, i32) {
        let login = random_email();
        let user = insert_local_user(pool, &login, "password123").await;
        let account = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"));
        (user, login, account)
    }

    async fn email(pool: &PgPool, account: i32, thread: Option<i32>, labels: &[&str]) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, thread_id, sender, labels) \
             VALUES ($1, $2, $3, 'ada@x.com', $4) RETURNING id",
        )
        .bind(format!("g-{}", random_email()))
        .bind(account)
        .bind(thread)
        .bind(labels.iter().map(|l| l.to_string()).collect::<Vec<_>>())
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"))
    }

    async fn attach(pool: &PgPool, email: i32, account: i32, filename: &str, mime: &str) {
        sqlx::query(
            "INSERT INTO email_attachments (email_id, account_id, gmail_id, attachment_id, filename, mime_type, size) \
             VALUES ($1, $2, 'g', $3, $4, $5, 10)",
        )
        .bind(email)
        .bind(account)
        .bind(random_email())
        .bind(filename)
        .bind(mime)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("attachment: {e}"));
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn the_list_flags_invitations_by_calendar_part_or_outlook_label() {
        let pool = test_pool().await;
        let (user, _, account) = mailbox(&pool).await;
        let by_mime = email(&pool, account, None, &["INBOX"]).await;
        attach(&pool, by_mime, account, "invite.ics", "text/calendar").await;
        let by_name = email(&pool, account, None, &["INBOX"]).await;
        attach(
            &pool,
            by_name,
            account,
            "meeting.ICS",
            "application/octet-stream",
        )
        .await;
        let outlook = email(&pool, account, None, &["INBOX", "WAYVE_INVITE"]).await;
        let pdf = email(&pool, account, None, &["INBOX"]).await;
        attach(&pool, pdf, account, "report.pdf", "application/pdf").await;
        // A conversation is an invitation when any message is.
        let thread: i32 =
            sqlx::query_scalar("INSERT INTO email_threads (account_id) VALUES ($1) RETURNING id")
                .bind(account)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("thread: {e}"));
        let invited = email(&pool, account, Some(thread), &["INBOX"]).await;
        attach(&pool, invited, account, "invite.ics", "text/calendar").await;
        let _reply = email(&pool, account, Some(thread), &["INBOX"]).await;

        for grouped in [false, true] {
            let rows = repo::list(
                &pool,
                EmailListFilters {
                    user_id: user,
                    account_id: None,
                    folder: Some("all".into()),
                    inbox_status: None,
                    search: None,
                    before: None,
                    page_size: 50,
                    group_threads: grouped,
                },
            )
            .await
            .unwrap_or_else(|e| panic!("list: {e}"));
            let flag = |id: i32| rows.iter().find(|r| r.id == id).map(|r| r.is_invite);
            assert_eq!(flag(by_mime), Some(true));
            assert_eq!(flag(by_name), Some(true));
            assert_eq!(flag(outlook), Some(true));
            assert_eq!(flag(pdf), Some(false));
            // Only the conversation list carries thread ids.
            if grouped {
                let conversation = rows
                    .iter()
                    .find(|r| r.thread_id == Some(thread))
                    .unwrap_or_else(|| panic!("conversation missing"));
                assert!(conversation.is_invite, "any message makes it an invitation");
            }
        }

        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(&pool)
            .await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn the_endpoint_hides_others_mail_and_has_no_invite_for_fluxze_mail() {
        let pool = test_pool().await;
        let (owner, _, account) = mailbox(&pool).await;
        let (stranger, stranger_login, _) = mailbox(&pool).await;
        let gmail = email(&pool, account, None, &["INBOX"]).await;
        let native: i32 = sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, sender, source, recipient_user_id) \
             VALUES ($1, NULL, 'ada@x.com', 'wayve', $2) RETURNING id",
        )
        .bind(format!("wayve:test:{}", random_email()))
        .bind(stranger)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("native: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::email::invite::get_email_invite),
        )
        .await;
        let get = |id: i32| {
            actix_test::TestRequest::get()
                .uri(&format!("/emails/{id}/invite"))
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(stranger, &stranger_login)),
                ))
                .to_request()
        };
        // Someone else's email: not found, as for every email endpoint.
        let resp = actix_test::call_service(&app, get(gmail)).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert_eq!(body["error"], "Email not found");
        // Their own Fluxze mail has no provider copy to read an invite from.
        let resp = actix_test::call_service(&app, get(native)).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        assert_eq!(body["error"], "No invitation in this email");

        for u in [owner, stranger] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(u)
                .execute(&pool)
                .await;
        }
    }
}
