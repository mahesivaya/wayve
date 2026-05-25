#[cfg(test)]
mod tests {
    use wayve_security::jwt::{create_jwt, decode_jwt, get_user_id_from_request};
    use actix_web::test::TestRequest;

    fn ensure_test_secret() {
        unsafe {
            std::env::set_var("JWT_SECRET", "test-jwt-secret");
        }
    }

    #[test]
    #[serial_test::serial]
    fn round_trip_encode_decode() {
        ensure_test_secret();
        let token = create_jwt(42, "alice@example.com".to_string());
        let claims = decode_jwt(&token).expect("valid token decodes");
        assert_eq!(claims.sub, 42);
        assert_eq!(claims.email, "alice@example.com");
    }

    #[test]
    #[serial_test::serial]
    fn decode_rejects_garbage() {
        ensure_test_secret();
        assert!(decode_jwt("not-a-real-jwt").is_none());
    }

    #[test]
    #[serial_test::serial]
    fn decode_rejects_wrong_signature() {
        unsafe {
            std::env::set_var("JWT_SECRET", "first-test-secret");
        }
        let token = create_jwt(1, "x@y.z".to_string());
        unsafe {
            std::env::set_var("JWT_SECRET", "second-test-secret");
        }
        let result = decode_jwt(&token);
        ensure_test_secret();
        assert!(
            result.is_none(),
            "tokens signed with a different secret must not decode"
        );
    }

    #[test]
    #[serial_test::serial]
    fn extracts_user_id_from_bearer_header() {
        ensure_test_secret();
        let token = create_jwt(7, "bob@example.com".to_string());
        let req = TestRequest::default()
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_http_request();
        assert_eq!(get_user_id_from_request(&req), Some(7));
    }

    #[test]
    fn missing_header_returns_none() {
        let req = TestRequest::default().to_http_request();
        assert_eq!(get_user_id_from_request(&req), None);
    }

    #[test]
    fn header_without_bearer_prefix_returns_none() {
        let req = TestRequest::default()
            .insert_header(("Authorization", "Basic xyz"))
            .to_http_request();
        assert_eq!(get_user_id_from_request(&req), None);
    }
}
