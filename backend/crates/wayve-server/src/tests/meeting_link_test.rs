#[cfg(test)]
mod tests {
    use actix_web::body::to_bytes;
    use actix_web::http::StatusCode;

    use crate::scheduler::handler::meeting_link_response;
    use crate::scheduler::zoom::ZoomError;

    #[tokio::test]
    async fn success_returns_join_url_json() {
        let resp = meeting_link_response(Ok("https://zoom.us/j/123".into()));
        assert_eq!(resp.status(), StatusCode::OK);

        let body = to_bytes(resp.into_body())
            .await
            .unwrap_or_else(|_| panic!("read body"));
        let value: serde_json::Value =
            serde_json::from_slice(&body).unwrap_or_else(|err| panic!("parse json: {err}"));
        assert_eq!(value["join_url"], "https://zoom.us/j/123");
    }

    #[tokio::test]
    async fn missing_env_maps_to_service_unavailable() {
        let resp = meeting_link_response(Err(ZoomError::MissingEnv("ZOOM_ACCOUNT_ID")));
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn other_zoom_error_maps_to_bad_gateway() {
        let resp = meeting_link_response(Err(ZoomError::CreateStatus("upstream 500".into())));
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }
}
