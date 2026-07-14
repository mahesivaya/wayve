//! The SCIM 2.0 bearer-token mint and resolve flow. Only the SHA-256 hash of a
//! token is stored, a token resolves to exactly the org it was minted for, and
//! revoking one stops it resolving even when the correct hash is presented.

#[cfg(test)]
mod tests {
    use crate::scim::tokens::{generate, resolve, sha256_hex};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::Row;

    async fn make_org(pool: &sqlx::PgPool) -> i32 {
        let row = sqlx::query("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(format!("scim-test-{}", uuid::Uuid::new_v4().simple()))
            .fetch_one(pool)
            .await
            .expect("insert org");
        row.get("id")
    }

    async fn insert_token(
        pool: &sqlx::PgPool,
        org_id: i32,
        creator_id: i32,
        raw: &str,
        revoked: bool,
    ) -> i32 {
        let hash = sha256_hex(raw);
        let row = sqlx::query(
            r#"
            INSERT INTO scim_tokens
              (organization_id, name, token_hash, token_preview, created_by, revoked_at)
            VALUES ($1, $2, $3, 'preview', $4, CASE WHEN $5 THEN NOW() ELSE NULL END)
            RETURNING id
            "#,
        )
        .bind(org_id)
        .bind("test-token")
        .bind(&hash)
        .bind(creator_id)
        .bind(revoked)
        .fetch_one(pool)
        .await
        .expect("insert scim_token");
        row.get("id")
    }

    #[test]
    fn generate_returns_a_prefixed_token_and_matching_hash() {
        // Sanity: prefix + character set + length consistent with how the
        // dashboard markets the value.
        let (raw, hash, preview) = generate();
        assert!(
            raw.starts_with("wv_scim_"),
            "raw should be wv_scim_-prefixed"
        );
        assert_eq!(raw.len(), "wv_scim_".len() + 48, "raw length stable");
        assert_eq!(
            sha256_hex(&raw),
            hash,
            "stored hash must match sha256_hex(raw)"
        );
        assert!(preview.contains('…'), "preview should be redacted");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolve_returns_principal_for_live_token() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;
        let org_id = make_org(&pool).await;
        let (raw, _, _) = generate();
        let token_id = insert_token(&pool, org_id, user_id, &raw, false).await;

        let principal = resolve(&pool, &raw).await.expect("token should resolve");
        assert_eq!(principal.token_id, token_id);
        assert_eq!(principal.organization_id, org_id);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolve_rejects_unknown_token() {
        let pool = test_pool().await;
        let principal = resolve(&pool, "wv_scim_not_a_real_token").await;
        assert!(principal.is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolve_rejects_revoked_token() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;
        let org_id = make_org(&pool).await;
        let (raw, _, _) = generate();
        insert_token(&pool, org_id, user_id, &raw, true).await;

        // Revoked tokens are filtered out at the SQL layer (revoked_at IS NULL).
        let principal = resolve(&pool, &raw).await;
        assert!(principal.is_none(), "revoked tokens must not resolve");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn tokens_for_different_orgs_are_isolated() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "pw").await;
        let org_a = make_org(&pool).await;
        let org_b = make_org(&pool).await;
        let (raw_a, _, _) = generate();
        let (raw_b, _, _) = generate();
        insert_token(&pool, org_a, user_id, &raw_a, false).await;
        insert_token(&pool, org_b, user_id, &raw_b, false).await;

        let pa = resolve(&pool, &raw_a).await.expect("A resolves");
        let pb = resolve(&pool, &raw_b).await.expect("B resolves");
        assert_eq!(pa.organization_id, org_a);
        assert_eq!(pb.organization_id, org_b);
        assert_ne!(pa.organization_id, pb.organization_id);
    }
}
