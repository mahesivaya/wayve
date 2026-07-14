// `rbac::resolve_role_context` is the authority every authorization gate in the
// app consults on every request, so a regression here would silently change nine
// roles' worth of access decisions across three scopes. These tests resolve
// against fresh database rows rather than a mock.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::PgPool;
    use wayve_security::rbac::{Permission, Role, Scope, resolve_role_context};

    async fn insert_org(pool: &PgPool, name: &str) -> i32 {
        sqlx::query_scalar::<_, i32>("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"))
    }

    async fn attach_to_org(pool: &PgPool, user_id: i32, org_id: i32, account_type: &str) {
        sqlx::query("UPDATE users SET account_type = $1, organization_id = $2 WHERE id = $3")
            .bind(account_type)
            .bind(org_id)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("attach user: {e}"));
    }

    async fn set_org_role(pool: &PgPool, org_id: i32, user_id: i32, role: &str) {
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
        .unwrap_or_else(|e| panic!("set org role: {e}"));
    }

    async fn set_platform_role(pool: &PgPool, user_id: i32, role: &str) {
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, $2) \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set platform role: {e}"));
    }

    async fn cleanup_user(pool: &PgPool, user_id: i32) {
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await;
    }

    async fn cleanup_org(pool: &PgPool, org_id: i32) {
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    async fn personal_account_resolves_to_personal_owner() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;

        let ctx = resolve_role_context(&pool, user_id).await.unwrap();
        assert_eq!(ctx.scope, Scope::Personal);
        assert_eq!(ctx.role, Role::Owner);
        assert_eq!(ctx.organization_id, None);
        // Owner holds the entire permission catalog.
        assert!(ctx.has(Permission::OrgDelete));
        assert!(ctx.has(Permission::BillingManage));

        cleanup_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn organization_member_inherits_explicit_role() {
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("RBAC Resolve {}", random_email())).await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;
        attach_to_org(&pool, user_id, org_id, "organization").await;
        set_org_role(&pool, org_id, user_id, "security").await;

        let ctx = resolve_role_context(&pool, user_id).await.unwrap();
        assert_eq!(ctx.scope, Scope::Organization);
        assert_eq!(ctx.role, Role::Security);
        assert_eq!(ctx.organization_id, Some(org_id));
        assert!(ctx.has(Permission::AuditRead));
        assert!(ctx.has(Permission::SecurityManage));
        // Security must not be a back door into billing. It does hold
        // MembersManage by design, so that it can provision the accounts it
        // manages; see the rationale on P_SECURITY in rbac.rs::permissions_for.
        assert!(!ctx.has(Permission::BillingManage));

        cleanup_user(&pool, user_id).await;
        cleanup_org(&pool, org_id).await;
    }

    #[actix_web::test]
    async fn organization_account_without_membership_row_defaults_to_member() {
        // An `organization` user with no membership row must fall back to Member,
        // the least-privilege role, and never to something more powerful.
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("RBAC Default {}", random_email())).await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;
        attach_to_org(&pool, user_id, org_id, "organization").await;

        let ctx = resolve_role_context(&pool, user_id).await.unwrap();
        assert_eq!(ctx.scope, Scope::Organization);
        assert_eq!(ctx.role, Role::Member);
        assert!(ctx.has(Permission::AppsUse));
        assert!(!ctx.has(Permission::MembersManage));

        cleanup_user(&pool, user_id).await;
        cleanup_org(&pool, org_id).await;
    }

    #[actix_web::test]
    async fn organization_admin_account_without_role_defaults_to_owner() {
        // An `organization_admin` with no membership row yet must still resolve
        // to Owner, or a brand-new org would have no admin until a backfill ran.
        let pool = test_pool().await;
        let org_id = insert_org(&pool, &format!("RBAC OrgAdmin {}", random_email())).await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;
        attach_to_org(&pool, user_id, org_id, "organization_admin").await;

        let ctx = resolve_role_context(&pool, user_id).await.unwrap();
        assert_eq!(ctx.scope, Scope::Organization);
        assert_eq!(ctx.role, Role::Owner);
        assert!(ctx.has(Permission::OrgDelete));

        cleanup_user(&pool, user_id).await;
        cleanup_org(&pool, org_id).await;
    }

    #[actix_web::test]
    async fn platform_admin_resolves_to_platform_scope() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .unwrap();
        set_platform_role(&pool, user_id, "super_admin").await;

        let ctx = resolve_role_context(&pool, user_id).await.unwrap();
        assert_eq!(ctx.scope, Scope::Platform);
        assert_eq!(ctx.role, Role::SuperAdmin);
        // super_admin is owner minus billing.
        assert!(ctx.has(Permission::MembersManage));
        assert!(ctx.has(Permission::OrgDelete));
        assert!(!ctx.has(Permission::BillingManage));
        assert!(!ctx.has(Permission::BillingRead));

        let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
        cleanup_user(&pool, user_id).await;
    }

    #[actix_web::test]
    async fn unknown_role_string_falls_back_to_member() {
        // An unrecognized role string in the database must be demoted to the
        // baseline role, never allowed to unlock anything by accident.
        assert_eq!(Role::from_str("badger"), Role::Member);
        assert_eq!(Role::from_str(""), Role::Member);
        for role in Role::ALL {
            assert_eq!(Role::from_str(role.as_str()), role);
        }
    }
}
