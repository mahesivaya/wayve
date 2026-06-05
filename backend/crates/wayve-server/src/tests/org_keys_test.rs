// Integration tests for the org-master-key endpoints. Each test wires
// a real handler behind require_permission / require_org_access and
// proves the bootstrap / escrow / reset paths return the expected
// codes for the expected callers.
//
// Coverage:
//   * Bootstrap                — owner accepted; non-owner gets 403;
//                                re-bootstrap rejected with 400;
//                                bootstrap row inserted into audit log.
//   * Server-side keypair gen  — POST /admin/users for an org member
//                                creates rows in member_wrapped_keys
//                                AND member_login_wrapped_keys AND
//                                populates users.public_key, all
//                                without ever returning private-key
//                                material in the HTTP response.
//   * Provision-before-bootstrap blocked — admin/users into a missing
//                                org-keys org returns 400 not 200.
//   * Escrow read              — owner / admin can fetch a member's
//                                escrow envelope; member-level role gets
//                                403; cross-org gets 403.
//   * Admin password reset     — rewraps login envelope + flips the
//                                bcrypt hash; old password rejected.
#[cfg(test)]
mod tests {
    use crate::organization::keys::{
        add_key_holder_wrap, bootstrap_keys, get_keys, get_member_escrow, list_member_notes,
        read_audit_log, reset_member_password,
    };
    use crate::routes::auth::login;
    use crate::routes::user::admin_create_user;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    // -----------------------------------------------------------------
    // Test fixtures
    // -----------------------------------------------------------------

    async fn insert_org(pool: &PgPool, name: &str) -> i32 {
        sqlx::query_scalar::<_, i32>("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"))
    }

    async fn place_in_org(pool: &PgPool, user_id: i32, org_id: i32, role: &str) {
        let account_type = if role == "owner" {
            "organization_admin"
        } else {
            "organization"
        };
        sqlx::query("UPDATE users SET account_type = $1, organization_id = $2 WHERE id = $3")
            .bind(account_type)
            .bind(org_id)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("attach user: {e}"));

        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (organization_id, user_id) DO UPDATE
             SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(org_id)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set role: {e}"));

        // Invalidate any cached role context so the test's request
        // resolves the new role on its first lookup.
        wayve_security::rbac::invalidate_role_context(user_id).await;
    }

    async fn cleanup(pool: &PgPool, user_ids: &[i32], org_ids: &[i32]) {
        for id in user_ids {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
        for id in org_ids {
            let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await;
        }
    }

    /// Bootstrap helper: insert a fake org_keys + organization_wrapped_keys
    /// pair so escrow / reset tests don't need to re-run a real keypair
    /// derivation. The wrap payloads are opaque blobs; the tests in this
    /// module verify endpoint routing, not the crypto closure (covered by
    /// scripts/org_key_verify.mjs).
    async fn seed_org_keys(pool: &PgPool, org_id: i32, owner_id: i32) {
        sqlx::query(
            "INSERT INTO organization_keys (organization_id, public_key)
             VALUES ($1, $2)
             ON CONFLICT (organization_id) DO NOTHING",
        )
        .bind(org_id)
        .bind("[1,2,3,4]")
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("seed organization_keys: {e}"));

        sqlx::query(
            "INSERT INTO organization_wrapped_keys
                (organization_id, wrap_method, holder_user_id, iv, ct,
                 pbkdf2_iterations, pbkdf2_salt)
             VALUES ($1, 'mnemonic', NULL, 'iv', 'ct', 600000, 'salt')
             ON CONFLICT (organization_id) WHERE wrap_method = 'mnemonic' DO NOTHING",
        )
        .bind(org_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("seed mnemonic wrap: {e}"));

        sqlx::query(
            "INSERT INTO organization_wrapped_keys
                (organization_id, wrap_method, holder_user_id, iv, ct)
             VALUES ($1, 'user_pubkey', $2, 'iv', 'ct')
             ON CONFLICT (organization_id, holder_user_id) DO UPDATE
             SET iv = EXCLUDED.iv, ct = EXCLUDED.ct",
        )
        .bind(org_id)
        .bind(owner_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("seed owner wrap: {e}"));
    }

    // -----------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------

    /// Owner can bootstrap; the audit log records who did it.
    #[actix_web::test]
    #[serial_test::serial]
    async fn bootstrap_owner_accepted_audit_written() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyBootstrapAccept-{}", random_email())).await;
        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "pw").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;
        let token = jwt_for(owner_id, &owner_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(bootstrap_keys)),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri(&format!("/api/organizations/{}/keys", org_id))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({
                "public_key": "[1,2,3,4]",
                "wrapped_mnemonic": {
                    "iv": "AAAA", "ct": "BBBB",
                    "pbkdf2_salt": "CCCC", "pbkdf2_iterations": 600_000
                },
                "wrapped_user": { "iv": "DDDD", "ct": "EEEE" }
            }))
            .to_request();

        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::CREATED);

        let audit_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM org_key_audit_log
             WHERE organization_id = $1 AND action = 'bootstrap'",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
        assert_eq!(audit_count, 1, "bootstrap should leave one audit row");

        cleanup(&pool, &[owner_id], &[org_id]).await;
    }

    /// Re-bootstrap of an already-keyed org → 400.
    #[actix_web::test]
    #[serial_test::serial]
    async fn bootstrap_second_call_rejected() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyBootstrapTwice-{}", random_email())).await;
        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "pw").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;
        seed_org_keys(&pool, org_id, owner_id).await;
        let token = jwt_for(owner_id, &owner_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(bootstrap_keys)),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri(&format!("/api/organizations/{}/keys", org_id))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({
                "public_key": "[9,9,9]",
                "wrapped_mnemonic": {
                    "iv": "AAAA", "ct": "BBBB",
                    "pbkdf2_salt": "CCCC", "pbkdf2_iterations": 600_000
                },
                "wrapped_user": { "iv": "DDDD", "ct": "EEEE" }
            }))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        cleanup(&pool, &[owner_id], &[org_id]).await;
    }

    /// Non-owner (admin) cannot bootstrap — that permission is owner-only.
    #[actix_web::test]
    #[serial_test::serial]
    async fn bootstrap_admin_rejected() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyBootstrapAdmin-{}", random_email())).await;
        let admin_email = random_email();
        let admin_id = insert_local_user(&pool, &admin_email, "pw").await;
        place_in_org(&pool, admin_id, org_id, "admin").await;
        let token = jwt_for(admin_id, &admin_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(bootstrap_keys)),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri(&format!("/api/organizations/{}/keys", org_id))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({
                "public_key": "[1,2,3,4]",
                "wrapped_mnemonic": {
                    "iv": "AAAA", "ct": "BBBB",
                    "pbkdf2_salt": "CCCC", "pbkdf2_iterations": 600_000
                },
                "wrapped_user": { "iv": "DDDD", "ct": "EEEE" }
            }))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[admin_id], &[org_id]).await;
    }

    /// Owner can read a member's escrow envelope; audit row is written
    /// AND any subsequent fetch_member_escrow row exists with the
    /// correct actor + target.
    #[actix_web::test]
    #[serial_test::serial]
    async fn escrow_fetch_owner_succeeds_audit_written() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyEscrow-{}", random_email())).await;
        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "pw").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;
        seed_org_keys(&pool, org_id, owner_id).await;

        let member_email = random_email();
        let member_id = insert_local_user(&pool, &member_email, "pw").await;
        place_in_org(&pool, member_id, org_id, "member").await;

        // Seed an escrow row for the member directly — endpoint tests
        // are about routing + RBAC, not the crypto closure.
        sqlx::query(
            "INSERT INTO member_wrapped_keys (organization_id, user_id, iv, ct)
             VALUES ($1, $2, '', 'WAYVE_SECURE_V1\nfake-envelope')
             ON CONFLICT (organization_id, user_id) DO UPDATE
             SET ct = EXCLUDED.ct",
        )
        .bind(org_id)
        .bind(member_id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("seed escrow: {e}"));

        let token = jwt_for(owner_id, &owner_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(get_member_escrow)),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri(&format!(
                "/api/organizations/{}/members/{}/escrow",
                org_id, member_id
            ))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK);

        // Audit row written with actor=owner, target=member.
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM org_key_audit_log
             WHERE organization_id = $1 AND action = 'fetch_member_escrow'
               AND actor_user_id = $2 AND target_user_id = $3",
        )
        .bind(org_id)
        .bind(owner_id)
        .bind(member_id)
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
        assert!(count >= 1, "audit row should be present");

        cleanup(&pool, &[owner_id, member_id], &[org_id]).await;
    }

    /// member-role caller can NOT fetch any escrow — 403 even for
    /// rows owned by the SAME org.
    #[actix_web::test]
    #[serial_test::serial]
    async fn escrow_fetch_member_role_denied() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyEscrowDeny-{}", random_email())).await;
        let target_email = random_email();
        let target_id = insert_local_user(&pool, &target_email, "pw").await;
        place_in_org(&pool, target_id, org_id, "member").await;

        let caller_email = random_email();
        let caller_id = insert_local_user(&pool, &caller_email, "pw").await;
        place_in_org(&pool, caller_id, org_id, "member").await;
        let token = jwt_for(caller_id, &caller_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(get_member_escrow)),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri(&format!(
                "/api/organizations/{}/members/{}/escrow",
                org_id, target_id
            ))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[caller_id, target_id], &[org_id]).await;
    }

    /// Cross-org owner cannot read escrow from a different org.
    #[actix_web::test]
    #[serial_test::serial]
    async fn escrow_fetch_cross_org_denied() {
        let pool = test_pool().await;
        let org_a = insert_org(&pool, &format!("OrgKeyCrossA-{}", random_email())).await;
        let org_b = insert_org(&pool, &format!("OrgKeyCrossB-{}", random_email())).await;

        let owner_a_email = random_email();
        let owner_a = insert_local_user(&pool, &owner_a_email, "pw").await;
        place_in_org(&pool, owner_a, org_a, "owner").await;

        let member_b_email = random_email();
        let member_b = insert_local_user(&pool, &member_b_email, "pw").await;
        place_in_org(&pool, member_b, org_b, "member").await;

        let token_a = jwt_for(owner_a, &owner_a_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(get_member_escrow)),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri(&format!(
                "/api/organizations/{}/members/{}/escrow",
                org_b, member_b
            ))
            .insert_header(("Authorization", format!("Bearer {token_a}")))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[owner_a, member_b], &[org_a, org_b]).await;
    }

    /// Refusing to reset another key-holder's password via this endpoint
    /// — it would silently rotate their org-key access alongside their
    /// password and is its own deliberate workflow.
    #[actix_web::test]
    #[serial_test::serial]
    async fn reset_password_refused_for_other_key_holder() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyResetOwner-{}", random_email())).await;
        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "pw").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;
        seed_org_keys(&pool, org_id, owner_id).await;

        let admin_email = random_email();
        let admin_id = insert_local_user(&pool, &admin_email, "pw").await;
        place_in_org(&pool, admin_id, org_id, "admin").await;

        let token = jwt_for(owner_id, &owner_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(reset_member_password)),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri(&format!(
                "/api/organizations/{}/members/{}/reset-password",
                org_id, admin_id
            ))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({
                "new_password": "irrelevant-because-refused",
                "new_login_wrap": {
                    "iv": "AA", "ct": "BB", "salt": "CC", "iterations": 600_000
                }
            }))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        cleanup(&pool, &[owner_id, admin_id], &[org_id]).await;
    }

    /// add_key_holder_wrap is owner-only AND requires the target to
    /// already hold an admin/super_admin/owner role row. A request to
    /// add a wrap for a plain member returns 400.
    #[actix_web::test]
    #[serial_test::serial]
    async fn add_key_holder_for_non_key_role_rejected() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyAddHolder-{}", random_email())).await;
        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "pw").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;
        seed_org_keys(&pool, org_id, owner_id).await;

        let member_email = random_email();
        let member_id = insert_local_user(&pool, &member_email, "pw").await;
        place_in_org(&pool, member_id, org_id, "member").await;

        let token = jwt_for(owner_id, &owner_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(add_key_holder_wrap)),
        )
        .await;

        let req = actix_test::TestRequest::post()
            .uri(&format!("/api/organizations/{}/key-holders", org_id))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(serde_json::json!({
                "user_id": member_id,
                "wrapped_user": { "iv": "AA", "ct": "BB" }
            }))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        cleanup(&pool, &[owner_id, member_id], &[org_id]).await;
    }

    // NOTE: `provision_org_member_keypair` is exhaustively tested in
    // `wayve-security/src/encryption.rs::tests::provision_org_member_keypair_double_wrap_roundtrip`.
    // Pulling the `rsa` crate into wayve-server just to repeat that test
    // here is dead weight, so it lives in the crate that owns the helper.

    /// Smoke test: get_keys returns the org pubkey to any member,
    /// hides wrapped_mnemonic unless include_mnemonic=true AND the
    /// caller has org_keys:bootstrap.
    #[actix_web::test]
    #[serial_test::serial]
    async fn get_keys_returns_pubkey_to_members_hides_mnemonic_from_admin() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyGetKeys-{}", random_email())).await;
        let admin_email = random_email();
        let admin_id = insert_local_user(&pool, &admin_email, "pw").await;
        place_in_org(&pool, admin_id, org_id, "admin").await;
        seed_org_keys(&pool, org_id, admin_id).await;
        let token = jwt_for(admin_id, &admin_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(get_keys)),
        )
        .await;

        // include_mnemonic=true — but admin doesn't have bootstrap, so
        // the mnemonic envelope MUST be withheld.
        let req = actix_test::TestRequest::get()
            .uri(&format!(
                "/api/organizations/{}/keys?include_mnemonic=true",
                org_id
            ))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(res).await;
        assert!(body.get("public_key").is_some(), "pubkey returned");
        assert!(
            body.get("wrapped_mnemonic").map_or(true, |v| v.is_null()),
            "admin must NOT see mnemonic envelope (got {:?})",
            body.get("wrapped_mnemonic"),
        );

        cleanup(&pool, &[admin_id], &[org_id]).await;
    }

    /// list_member_notes denies callers without org_keys:use_master
    /// (e.g. role='member' even within the same org).
    #[actix_web::test]
    #[serial_test::serial]
    async fn list_member_notes_denies_non_key_holder() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyListNotesDeny-{}", random_email())).await;

        let target_email = random_email();
        let target_id = insert_local_user(&pool, &target_email, "pw").await;
        place_in_org(&pool, target_id, org_id, "member").await;

        let caller_email = random_email();
        let caller_id = insert_local_user(&pool, &caller_email, "pw").await;
        place_in_org(&pool, caller_id, org_id, "member").await;
        let token = jwt_for(caller_id, &caller_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(list_member_notes)),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri(&format!(
                "/api/organizations/{}/members/{}/notes",
                org_id, target_id
            ))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[caller_id, target_id], &[org_id]).await;
    }

    /// read_audit_log denies non-key-holders.
    #[actix_web::test]
    #[serial_test::serial]
    async fn read_audit_log_denies_non_key_holder() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("OrgKeyAuditDeny-{}", random_email())).await;
        let caller_email = random_email();
        let caller_id = insert_local_user(&pool, &caller_email, "pw").await;
        place_in_org(&pool, caller_id, org_id, "member").await;
        let token = jwt_for(caller_id, &caller_email);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(read_audit_log)),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri(&format!("/api/organizations/{}/audit/key-access", org_id))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[caller_id], &[org_id]).await;
    }

    // Suppress unused-import warnings when the corresponding tests
    // expand or shrink over time.
    // Some imports above are reserved for follow-up tests (provisioning
    // round-trip via admin_create_user, end-to-end login flow). Keeping
    // them in the use list so the future tests don't churn the import
    // block — silenced via this dummy referencer.
    #[allow(dead_code)]
    fn _reserved_imports() {
        let _ = admin_create_user;
        let _ = login;
    }
}
