// Integration tests for the org-master-key endpoints: each test drives a real
// handler behind require_permission / require_org_access and pins the status
// code the bootstrap, escrow and reset paths owe each class of caller.
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

        // The role context is cached, so it must be invalidated or the request
        // under test would resolve the user's stale role.
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

    /// Seeds fake key rows so escrow and reset tests skip a real keypair
    /// derivation. The wrap payloads are opaque blobs: these tests cover endpoint
    /// routing and RBAC, not the crypto closure (see scripts/org_key_verify.mjs).
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

    /// An owner can bootstrap, and the audit log records who did it.
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

    /// Re-bootstrapping an already-keyed org is rejected, so an existing master
    /// key can never be overwritten.
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

    /// An owner can read a member's escrow envelope, and the read is recorded
    /// in the audit log with the correct actor and target.
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

    /// A member-role caller cannot fetch an escrow envelope even for a member
    /// of their own org.
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

    /// Resetting another key-holder's password through this endpoint is
    /// refused, because it would silently rotate their org-key access along
    /// with their password.
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

    /// A key-holder wrap can only be added for a target who already holds an
    /// admin, super_admin or owner role, never a plain member.
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

    // `provision_org_member_keypair` is tested in
    // `wayve-security/src/encryption.rs::tests::provision_org_member_keypair_double_wrap_roundtrip`,
    // in the crate that owns it, so wayve-server need not depend on `rsa`.

    /// The org public key is readable by any member, but the wrapped mnemonic
    /// is withheld unless the caller holds org_keys:bootstrap.
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

    /// Listing a member's notes is denied to callers without
    /// org_keys:use_master, even inside the same org.
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

    /// The key-access audit log is denied to non-key-holders.
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

    // Holds imports reserved for follow-up tests so they do not trip the
    // unused-import warning.
    #[allow(dead_code)]
    fn _reserved_imports() {
        let _ = admin_create_user;
        let _ = login;
    }
}
