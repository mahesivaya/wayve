// End-to-end RBAC gates. Each test wires up a real handler behind
// `require_permission` / `require_org_access` and proves the 401/403/200
// branches by hitting it through an actix test server. The point is to catch a
// regression at the *gate*, not the matrix — for example, a future refactor
// that forgot to consult `organization_id` would let an Org member operate on
// another tenant, and the cross-tenant test below would fail.
#[cfg(test)]
mod tests {
    use crate::routes::user::{list_organization_members, update_organization_member_role};
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
        sqlx::query(
            "UPDATE users SET account_type = 'organization', organization_id = $1 WHERE id = $2",
        )
        .bind(org_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("attach user: {e}"));

        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (organization_id, user_id) DO UPDATE \
             SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(org_id)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set role: {e}"));
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

    #[actix_web::test]
    async fn members_list_requires_authentication() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("RBAC NoAuth {}", random_email())).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(list_organization_members),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri(&format!("/organizations/{org_id}/members"))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        cleanup(&pool, &[], &[org_id]).await;
    }

    #[actix_web::test]
    async fn members_list_blocks_cross_tenant_access() {
        // The whole point of `require_org_access`: an organization member with
        // the right permission must still be denied when the org id in the URL
        // is a tenant they don't belong to. Platform staff bypass that check.
        let pool = test_pool().await;
        let org_a = insert_org(&pool, &format!("Tenant A {}", random_email())).await;
        let org_b = insert_org(&pool, &format!("Tenant B {}", random_email())).await;

        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "password123").await;
        place_in_org(&pool, owner_id, org_a, "owner").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(list_organization_members),
        )
        .await;

        // Listing own org: 200.
        let req = actix_test::TestRequest::get()
            .uri(&format!("/organizations/{org_a}/members"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(owner_id, &owner_email)),
            ))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Listing the other tenant: 403 — same permission, wrong scope.
        let req = actix_test::TestRequest::get()
            .uri(&format!("/organizations/{org_b}/members"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(owner_id, &owner_email)),
            ))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        cleanup(&pool, &[owner_id], &[org_a, org_b]).await;
    }

    #[actix_web::test]
    async fn role_change_takes_effect_on_next_request() {
        // Authorization is computed per-request straight from the DB, so a
        // role change made after the JWT was minted must be honored
        // immediately — no waiting for a token refresh.
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("Effective {}", random_email())).await;

        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "password123").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;

        let actor_email = random_email();
        let actor_id = insert_local_user(&pool, &actor_email, "password123").await;
        place_in_org(&pool, actor_id, org_id, "member").await;

        let target_id = insert_local_user(&pool, &random_email(), "password123").await;
        place_in_org(&pool, target_id, org_id, "member").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(update_organization_member_role),
        )
        .await;

        let put = |actor: (i32, &str), uid: i32, role: &str| {
            actix_test::TestRequest::put()
                .uri(&format!("/organizations/{org_id}/members/{uid}/role"))
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(actor.0, actor.1)),
                ))
                .set_json(serde_json::json!({ "role": role }))
                .to_request()
        };

        // Mint a token while actor is still a plain member.
        let actor_token = jwt_for(actor_id, &actor_email);
        // Before promotion: actor lacks roles:assign_limited → 403.
        let req = actix_test::TestRequest::put()
            .uri(&format!("/organizations/{org_id}/members/{target_id}/role"))
            .insert_header(("Authorization", format!("Bearer {actor_token}")))
            .set_json(serde_json::json!({ "role": "support" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Owner promotes actor to admin (so they hold roles:assign_limited).
        let resp =
            actix_test::call_service(&app, put((owner_id, &owner_email), actor_id, "admin")).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The same already-minted token now passes — the gate consulted the DB,
        // not the JWT claims.
        let req = actix_test::TestRequest::put()
            .uri(&format!("/organizations/{org_id}/members/{target_id}/role"))
            .insert_header(("Authorization", format!("Bearer {actor_token}")))
            .set_json(serde_json::json!({ "role": "support" }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        cleanup(&pool, &[owner_id, actor_id, target_id], &[org_id]).await;
    }

    #[actix_web::test]
    async fn admin_cannot_assign_or_modify_admin_or_above() {
        // `roles:assign_limited` (held by admin) must never let the holder
        // promote anyone to admin/owner or touch an existing one. The matrix
        // already covers this in the unit tests; this exercises the HTTP path.
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("Limited {}", random_email())).await;

        let admin_email = random_email();
        let admin_id = insert_local_user(&pool, &admin_email, "password123").await;
        place_in_org(&pool, admin_id, org_id, "admin").await;

        let owner_id = insert_local_user(&pool, &random_email(), "password123").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;

        let target_id = insert_local_user(&pool, &random_email(), "password123").await;
        place_in_org(&pool, target_id, org_id, "member").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(update_organization_member_role),
        )
        .await;

        let put = |uid: i32, role: &str| {
            actix_test::TestRequest::put()
                .uri(&format!("/organizations/{org_id}/members/{uid}/role"))
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(admin_id, &admin_email)),
                ))
                .set_json(serde_json::json!({ "role": role }))
                .to_request()
        };

        // Promoting a member to admin is forbidden.
        let resp = actix_test::call_service(&app, put(target_id, "admin")).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Demoting the owner is forbidden too — admin can't touch superiors.
        let resp = actix_test::call_service(&app, put(owner_id, "member")).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // But admin can re-assign a member within the below-admin band.
        let resp = actix_test::call_service(&app, put(target_id, "support")).await;
        assert_eq!(resp.status(), StatusCode::OK);

        cleanup(&pool, &[admin_id, owner_id, target_id], &[org_id]).await;
    }

    #[actix_web::test]
    async fn unknown_role_string_is_rejected_with_400() {
        // The handler intentionally rejects anything that doesn't round-trip
        // through `Role::from_str` — so a typo / case variant becomes a clean
        // 400, not a silent fall-through to Member.
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("BadRole {}", random_email())).await;

        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "password123").await;
        place_in_org(&pool, owner_id, org_id, "owner").await;

        let target_id = insert_local_user(&pool, &random_email(), "password123").await;
        place_in_org(&pool, target_id, org_id, "member").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(update_organization_member_role),
        )
        .await;

        for bad in ["Owner", "MEMBER", "captain", ""] {
            let req = actix_test::TestRequest::put()
                .uri(&format!("/organizations/{org_id}/members/{target_id}/role"))
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(owner_id, &owner_email)),
                ))
                .set_json(serde_json::json!({ "role": bad }))
                .to_request();
            let resp = actix_test::call_service(&app, req).await;
            assert_eq!(
                resp.status(),
                StatusCode::BAD_REQUEST,
                "expected 400 for role={bad:?}"
            );
        }

        cleanup(&pool, &[owner_id, target_id], &[org_id]).await;
    }
}
