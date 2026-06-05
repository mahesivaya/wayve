//! Tests for `embed` tokens — short-lived, read-only, origin-pinned JWTs
//! used to embed Wayve surfaces inside customer iframes.
//!
//! Covers:
//!   * Mint validates origin + scopes; unknown scopes 400.
//!   * Verify round-trips a freshly-minted token.
//!   * Verify rejects tokens with the wrong issuer.
//!   * Verify rejects expired tokens (manually-forged claim).
//!   * Allowed-scope catalog is read-only — refuses every write scope.

#[cfg(test)]
mod tests {
    use crate::embed::tokens::{
        ALLOWED_SCOPES, EMBED_ISSUER, MintError, VerifyError, mint, verify,
    };
    use chrono::{Duration as ChronoDuration, Utc};
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde::Serialize;

    fn ensure_jwt_secret() {
        unsafe {
            if std::env::var("JWT_SECRET").is_err() {
                std::env::set_var("JWT_SECRET", "test-jwt-secret-embed-tests");
            }
        }
    }

    #[test]
    fn allowed_scopes_are_read_only() {
        // Every allowed scope must end in ":read" — embed tokens must
        // never be permitted to mutate state. Adding a write scope to
        // ALLOWED_SCOPES without changing this rule would silently
        // weaken the embed contract.
        for scope in ALLOWED_SCOPES {
            assert!(
                scope.ends_with(":read"),
                "embed scope {scope} must be a :read scope"
            );
        }
        // Sanity: catalog isn't accidentally empty.
        assert!(
            !ALLOWED_SCOPES.is_empty(),
            "ALLOWED_SCOPES must not be empty"
        );
    }

    #[test]
    #[serial_test::serial]
    fn mint_rejects_empty_origin() {
        ensure_jwt_secret();
        let err = mint(7, "   ", &["profile:read".to_string()]).unwrap_err();
        assert!(matches!(err, MintError::EmptyOrigin));
    }

    #[test]
    #[serial_test::serial]
    fn mint_rejects_empty_scopes() {
        ensure_jwt_secret();
        let err = mint(7, "https://customer.example", &[]).unwrap_err();
        assert!(matches!(err, MintError::EmptyScopes));
    }

    #[test]
    #[serial_test::serial]
    fn mint_rejects_scope_outside_catalog() {
        ensure_jwt_secret();
        let err = mint(
            7,
            "https://customer.example",
            &["email:send".to_string()], // write scope, not allowed
        )
        .unwrap_err();
        match err {
            MintError::UnknownScope(s) => assert_eq!(s, "email:send"),
            other => panic!("expected UnknownScope, got {other:?}"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn verify_round_trips_a_freshly_minted_token() {
        ensure_jwt_secret();
        let user_id = 42;
        let origin = "https://customer.example";
        let scopes = vec!["profile:read".to_string(), "email:read".to_string()];

        let token = mint(user_id, origin, &scopes).expect("mint succeeds");
        let claims = verify(&token).expect("verify succeeds");

        assert_eq!(claims.sub, user_id);
        assert_eq!(claims.iss, EMBED_ISSUER);
        assert_eq!(claims.aud, origin);
        assert_eq!(claims.scopes, scopes);
        assert!(
            claims.jti.starts_with("emb_"),
            "embed jti should be prefixed for log correlation"
        );
    }

    #[test]
    #[serial_test::serial]
    fn verify_rejects_token_with_wrong_issuer() {
        ensure_jwt_secret();
        let secret =
            std::env::var("JWT_SECRET").unwrap_or_else(|_| "test-jwt-secret-embed-tests".into());
        #[derive(Serialize)]
        struct Forged {
            sub: i32,
            iss: String,
            aud: String,
            scopes: Vec<String>,
            exp: usize,
            jti: String,
        }
        let exp = (Utc::now() + ChronoDuration::seconds(300)).timestamp() as usize;
        let forged = Forged {
            sub: 1,
            iss: "wayve-session".into(), // <-- wrong issuer
            aud: "https://customer.example".into(),
            scopes: vec!["profile:read".into()],
            exp,
            jti: "emb_forged".into(),
        };
        let token = encode(
            &Header::default(),
            &forged,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("encode forged");

        match verify(&token) {
            Err(VerifyError::WrongIssuer) => {}
            other => panic!("expected WrongIssuer, got {other:?}"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn verify_rejects_expired_token() {
        ensure_jwt_secret();
        let secret =
            std::env::var("JWT_SECRET").unwrap_or_else(|_| "test-jwt-secret-embed-tests".into());
        #[derive(Serialize)]
        struct Expired {
            sub: i32,
            iss: String,
            aud: String,
            scopes: Vec<String>,
            exp: usize,
            jti: String,
        }
        // 1 hour in the past — well outside jsonwebtoken's default 60-second
        // leeway window, so verify() must classify as Expired (not just decode).
        let exp = (Utc::now() - ChronoDuration::hours(1)).timestamp() as usize;
        let expired = Expired {
            sub: 1,
            iss: EMBED_ISSUER.to_string(),
            aud: "https://customer.example".into(),
            scopes: vec!["profile:read".into()],
            exp,
            jti: "emb_expired".into(),
        };
        let token = encode(
            &Header::default(),
            &expired,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("encode expired");

        match verify(&token) {
            Err(VerifyError::Expired) => {}
            other => panic!("expected Expired, got {other:?}"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn verify_rejects_garbage_token() {
        ensure_jwt_secret();
        match verify("not-a-jwt") {
            Err(VerifyError::Decode) => {}
            other => panic!("expected Decode, got {other:?}"),
        }
    }
}
