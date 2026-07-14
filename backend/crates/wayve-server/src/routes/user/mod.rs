//! User, organization, and RBAC member endpoints.
//!
//! Split into focused submodules; everything public is re-exported here so the
//! route table (`routes::routes`) and cross-module callers continue to use the
//! `crate::routes::user::*` paths unchanged.

mod api_keys;
mod members;
mod organizations;
mod profile;
mod shared;

pub use api_keys::*;
pub use members::*;
pub use organizations::*;
pub use profile::*;
pub use shared::*;

#[cfg(test)]
mod auth_regression_tests {
    use super::*;
    use sqlx::PgPool;
    use wayve_security::api_key::hash_api_key;

    #[test]
    fn test_normalized_account_type() {
        assert_eq!(normalized_account_type("personal"), "personal");
        assert_eq!(normalized_account_type("organization"), "organization");
        assert_eq!(
            normalized_account_type("organization_admin"),
            "organization_admin"
        );
        assert_eq!(normalized_account_type("platform_admin"), "platform_admin");
        assert_eq!(normalized_account_type("unknown"), "personal");
    }

    #[test]
    fn test_display_organization_name() {
        assert_eq!(
            display_organization_name("personal", "user@example.com", None),
            Some("user@example.com".to_string())
        );
        assert_eq!(
            display_organization_name(
                "organization",
                "member@example.com",
                Some("Example Org".to_string())
            ),
            Some("Example Org".to_string())
        );
        assert_eq!(
            display_organization_name("platform_admin", "admin@example.com", None),
            None
        );
    }

    #[actix_web::test]
    async fn test_api_key_generation_and_validation() {
        use crate::test_support::test_pool;
        let pool = test_pool().await;

        // The org name is UUID-suffixed so repeated runs don't trip the
        // organizations.name UNIQUE constraint.
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let org_id: i32 =
            sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
                .bind(format!("Test Org {unique}"))
                .fetch_one(&pool)
                .await
                .unwrap();

        // raw_key is UUID-tagged for the same reason: api_keys.key_hash is UNIQUE.
        let raw_key = format!("wv_sk_test_secret_{unique}");
        let key_hash = hash_api_key(&raw_key);

        sqlx::query("INSERT INTO api_keys (organization_id, name, key_hash, key_preview) VALUES ($1, $2, $3, $4)")
            .bind(org_id)
            .bind("Test Key")
            .bind(&key_hash)
            .bind(format!("wv_sk_..._{unique}"))
            .execute(&pool)
            .await
            .unwrap();

        let req = actix_test::TestRequest::default()
            .insert_header(("X-API-KEY", raw_key.as_str()))
            .to_http_request();

        let validated_org_id = validate_api_key(&req, &pool).await;
        assert_eq!(validated_org_id, Some(org_id));

        let req_bad = actix_test::TestRequest::default()
            .insert_header(("X-API-KEY", "wrong_key"))
            .to_http_request();

        let validated_bad = validate_api_key(&req_bad, &pool).await;
        assert!(validated_bad.is_none());
    }

    // The actix test module is aliased because a bare `test` import shadows the
    // built-in `#[test]` attribute and would reject the sync unit test above.
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::postgres::PgPoolOptions;

    fn lazy_pool() -> PgPool {
        PgPoolOptions::new()
            .connect_lazy("postgres://postgres:postgres@localhost/rwayve_test")
            .expect("lazy pool")
    }

    #[actix_web::test]
    async fn get_user_by_email_requires_auth() {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(lazy_pool()))
                .service(get_user_by_email),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/users?email=target@example.com")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn get_all_users_requires_auth() {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(lazy_pool()))
                .service(get_all_users),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/users/all")
            .to_request();
        let resp = actix_test::call_service(&app, req).await;

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    async fn update_organization_member_role_authorization() {
        use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
        let pool = test_pool().await;

        // An organization with an owner, a plain member, and a target member.
        let org_id: i32 =
            sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
                .bind(format!("RBAC Org {}", random_email()))
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("create org: {e}"));

        let owner_email = random_email();
        let owner_id = insert_local_user(&pool, &owner_email, "password123").await;
        let member_email = random_email();
        let member_id = insert_local_user(&pool, &member_email, "password123").await;
        let target_email = random_email();
        let target_id = insert_local_user(&pool, &target_email, "password123").await;

        for (uid, role) in [
            (owner_id, "owner"),
            (member_id, "member"),
            (target_id, "member"),
        ] {
            sqlx::query(
                "UPDATE users SET account_type = 'organization', organization_id = $1 WHERE id = $2",
            )
            .bind(org_id)
            .bind(uid)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("attach user to org: {e}"));
            sqlx::query(
                "INSERT INTO organization_members (organization_id, user_id, role) \
                 VALUES ($1, $2, $3)",
            )
            .bind(org_id)
            .bind(uid)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("insert membership: {e}"));
        }

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(update_organization_member_role),
        )
        .await;

        let put = |actor_id: i32, actor_email: &str, uid: i32, role: &str| {
            actix_test::TestRequest::put()
                .uri(&format!("/organizations/{org_id}/members/{uid}/role"))
                .insert_header((
                    "Authorization",
                    format!("Bearer {}", jwt_for(actor_id, actor_email)),
                ))
                .set_json(serde_json::json!({ "role": role }))
                .to_request()
        };

        // Owner holds roles:manage — may demote the target member.
        let resp =
            actix_test::call_service(&app, put(owner_id, &owner_email, target_id, "developer"))
                .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // A plain member has no role-management permission — 403.
        let resp =
            actix_test::call_service(&app, put(member_id, &member_email, target_id, "support"))
                .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // The sole owner cannot demote themselves — 409.
        let resp =
            actix_test::call_service(&app, put(owner_id, &owner_email, owner_id, "member")).await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);

        for uid in [owner_id, member_id, target_id] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(&pool)
            .await;
    }
}

/// Handlers live in the submodules and are re-exported via the globs above, so
/// they resolve by bare name here.
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(change_password)
        .service(admin_list_organizations)
        .service(admin_create_organization)
        .service(delete_my_organization)
        .service(update_my_organization)
        .service(delete_my_account)
        .service(admin_send_create_code)
        .service(admin_create_user)
        .service(admin_delete_user)
        .service(admin_generate_api_key)
        .service(admin_list_api_keys)
        .service(admin_revoke_api_key)
        .service(api_key_whoami)
        .service(list_organization_members)
        .service(organization_member_detail)
        .service(update_organization_member_role)
        .service(list_platform_members)
        .service(platform_member_detail)
        .service(update_platform_member_role)
        .service(platform_member_projects)
        .service(set_platform_member_projects)
        .service(organization_member_projects)
        .service(set_organization_member_projects)
        .service(get_user_by_email)
        .service(get_all_users)
        .service(get_profile)
        .service(update_profile)
        .service(upload_avatar)
        .service(get_avatar)
        .service(delete_avatar);
}
