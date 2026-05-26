#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use chrono::{DateTime, TimeZone, Utc};

    use crate::scheduler::zoom::{
        ZoomClient, ZoomError, build_meeting_body, create_zoom_meeting_with, encode_basic_auth,
    };

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .unwrap_or_else(|| panic!("valid datetime"))
    }

    #[test]
    fn basic_auth_matches_standard_base64() {
        let encoded = encode_basic_auth("client-id", "client-secret");
        let decoded = STANDARD
            .decode(&encoded)
            .unwrap_or_else(|err| panic!("decode base64: {err}"));
        assert_eq!(decoded, b"client-id:client-secret");
    }

    #[test]
    fn meeting_body_carries_required_fields() {
        let body = build_meeting_body("Quarterly Review", utc(2026, 5, 26, 9, 30), 45);

        assert_eq!(body["topic"], "Quarterly Review");
        assert_eq!(body["type"], 2);
        assert_eq!(body["duration"], 45);
        assert_eq!(body["timezone"], "UTC");
        assert_eq!(body["start_time"], "2026-05-26T09:30:00Z");
    }

    #[test]
    fn meeting_body_settings_match_contract() {
        let body = build_meeting_body("X", utc(2026, 1, 1, 0, 0), 30);
        let settings = &body["settings"];
        assert_eq!(settings["join_before_host"], true);
        assert_eq!(settings["approval_type"], 2);
        assert_eq!(settings["waiting_room"], false);
    }

    struct FakeZoom {
        join_url: String,
    }

    #[async_trait]
    impl ZoomClient for FakeZoom {
        async fn create_meeting(
            &self,
            _topic: &str,
            _start_utc: DateTime<Utc>,
            _duration_min: i64,
        ) -> Result<String, ZoomError> {
            Ok(self.join_url.clone())
        }
    }

    struct FailingZoom;

    #[async_trait]
    impl ZoomClient for FailingZoom {
        async fn create_meeting(
            &self,
            _topic: &str,
            _start_utc: DateTime<Utc>,
            _duration_min: i64,
        ) -> Result<String, ZoomError> {
            Err(ZoomError::CreateStatus("upstream 500".into()))
        }
    }

    #[tokio::test]
    async fn create_zoom_meeting_with_fake_returns_url() {
        let fake = FakeZoom {
            join_url: "https://zoom.us/j/123".into(),
        };
        let out = create_zoom_meeting_with(&fake, "Sync", utc(2026, 5, 26, 10, 0), 30)
            .await
            .unwrap_or_else(|err| panic!("expected Ok: {err}"));
        assert_eq!(out, "https://zoom.us/j/123");
    }

    #[tokio::test]
    async fn create_zoom_meeting_with_propagates_errors() {
        let out =
            create_zoom_meeting_with(&FailingZoom, "Sync", utc(2026, 5, 26, 10, 0), 30).await;
        match out {
            Err(ZoomError::CreateStatus(msg)) => assert_eq!(msg, "upstream 500"),
            other => panic!("expected CreateStatus, got {other:?}"),
        }
    }
}
