// The chat channel admin invariant: a channel with members always has an
// admin. Pins the concurrent mutual-removal race (serialized by the channel row
// lock), that "add" never demotes an existing member, the role and leave
// endpoints' last-admin guards, the org-owner recovery path for a channel that
// already lost every admin, and the `users` delete trigger that hands admin and
// creator off to a remaining member instead of stranding or deleting the channel.
#[cfg(test)]
mod tests {
    use crate::chat::handler::{
        add_channel_users, get_channels, leave_channel, remove_channel_user,
        set_channel_member_role,
    };
    use crate::test_support::{insert_local_user, jwt_for, jwt_for_mode, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wayve_security::jwt::SessionMode;

    struct Member {
        id: i32,
        email: String,
    }

    async fn user(pool: &PgPool) -> Member {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        Member { id, email }
    }

    /// An org whose members are `organization` accounts, plus its owner.
    async fn org_with_owner(pool: &PgPool) -> (i32, Member) {
        let org_id: i32 = sqlx::query_scalar(
            "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("Chan Org {}", random_email()))
        .bind(format!(
            "chan-org-{}",
            random_email().replace(['@', '.'], "-")
        ))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("create org: {e}"));
        let owner = org_user(pool, org_id, "organization_admin", "owner").await;
        (org_id, owner)
    }

    async fn org_user(pool: &PgPool, org_id: i32, account_type: &str, role: &str) -> Member {
        let m = user(pool).await;
        sqlx::query("UPDATE users SET organization_id = $1, account_type = $2 WHERE id = $3")
            .bind(org_id)
            .bind(account_type)
            .bind(m.id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("attach org user: {e}"));
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)",
        )
        .bind(org_id)
        .bind(m.id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("org member row: {e}"));
        m
    }

    /// A channel created by `members[0]`, with each member at the given role.
    async fn channel(pool: &PgPool, members: &[(&Member, &str)]) -> i32 {
        let channel_id: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by, visibility) VALUES ('c', $1, 'private') RETURNING id",
        )
        .bind(members[0].0.id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("create channel: {e}"));
        for (m, role) in members {
            sqlx::query(
                "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3)",
            )
            .bind(channel_id)
            .bind(m.id)
            .bind(*role)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("add channel member: {e}"));
        }
        channel_id
    }

    async fn role_of(pool: &PgPool, channel_id: i32, user_id: i32) -> Option<String> {
        sqlx::query_scalar(
            "SELECT role FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        )
        .bind(channel_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .unwrap_or_else(|e| panic!("role lookup: {e}"))
    }

    async fn admin_count(pool: &PgPool, channel_id: i32) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM channel_members WHERE channel_id = $1 AND role = 'admin'",
        )
        .bind(channel_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("admin count: {e}"))
    }

    macro_rules! app {
        ($pool:expr) => {
            actix_test::init_service(
                App::new()
                    .app_data(web::Data::new($pool.clone()))
                    .service(add_channel_users)
                    .service(remove_channel_user)
                    .service(set_channel_member_role)
                    .service(leave_channel)
                    .service(get_channels),
            )
            .await
        };
    }

    fn bearer(m: &Member) -> (&'static str, String) {
        (
            "Authorization",
            format!("Bearer {}", jwt_for(m.id, &m.email)),
        )
    }

    fn remove_req(actor: &Member, channel_id: i32, email: &str) -> actix_test::TestRequest {
        actix_test::TestRequest::delete()
            .uri(&format!("/chat/channels/{channel_id}/members"))
            .insert_header(bearer(actor))
            .set_json(serde_json::json!({ "email": email }))
    }

    fn role_req(
        actor: &Member,
        channel_id: i32,
        email: &str,
        role: &str,
    ) -> actix_test::TestRequest {
        actix_test::TestRequest::patch()
            .uri(&format!("/chat/channels/{channel_id}/members/role"))
            .insert_header(bearer(actor))
            .set_json(serde_json::json!({ "email": email, "role": role }))
    }

    fn leave_req(actor: &Member, channel_id: i32) -> actix_test::TestRequest {
        actix_test::TestRequest::post()
            .uri(&format!("/chat/channels/{channel_id}/leave"))
            .insert_header(bearer(actor))
    }

    #[actix_web::test]
    async fn two_admins_removing_each_other_at_once_keep_one_admin() {
        let pool = test_pool().await;
        let app = app!(pool);
        for _ in 0..8 {
            let (a, b, c) = (user(&pool).await, user(&pool).await, user(&pool).await);
            let channel_id = channel(&pool, &[(&a, "admin"), (&b, "admin"), (&c, "user")]).await;

            let (r1, r2) = tokio::join!(
                actix_test::call_service(&app, remove_req(&a, channel_id, &b.email).to_request()),
                actix_test::call_service(&app, remove_req(&b, channel_id, &a.email).to_request()),
            );
            let ok = [r1.status(), r2.status()]
                .iter()
                .filter(|s| **s == StatusCode::OK)
                .count();
            assert_eq!(
                ok,
                1,
                "exactly one removal wins: {} / {}",
                r1.status(),
                r2.status()
            );
            assert_eq!(
                admin_count(&pool, channel_id).await,
                1,
                "one admin must remain"
            );
        }
    }

    #[actix_web::test]
    async fn re_adding_an_admin_as_member_does_not_demote() {
        let pool = test_pool().await;
        let app = app!(pool);
        let a = user(&pool).await;
        let channel_id = channel(&pool, &[(&a, "admin")]).await;

        let req = actix_test::TestRequest::post()
            .uri(&format!("/chat/channels/{channel_id}/members"))
            .insert_header(bearer(&a))
            .set_json(serde_json::json!({ "invite_emails": [a.email], "invite_role": "user" }))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            role_of(&pool, channel_id, a.id).await.as_deref(),
            Some("admin")
        );
    }

    #[actix_web::test]
    async fn role_endpoint_promotes_and_refuses_demoting_the_last_admin() {
        let pool = test_pool().await;
        let app = app!(pool);
        let (a, b) = (user(&pool).await, user(&pool).await);
        let channel_id = channel(&pool, &[(&a, "admin"), (&b, "user")]).await;

        let resp = actix_test::call_service(
            &app,
            role_req(&a, channel_id, &a.email, "user").to_request(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "last admin can't self-demote"
        );

        let resp = actix_test::call_service(
            &app,
            role_req(&a, channel_id, &b.email, "admin").to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let resp = actix_test::call_service(
            &app,
            role_req(&a, channel_id, &a.email, "user").to_request(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "demotion allowed once another admin exists"
        );
        assert_eq!(
            role_of(&pool, channel_id, a.id).await.as_deref(),
            Some("user")
        );

        let resp = actix_test::call_service(
            &app,
            role_req(&a, channel_id, &b.email, "user").to_request(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "a demoted admin can't manage roles"
        );
    }

    #[actix_web::test]
    async fn leave_is_open_to_members_but_not_the_last_admin() {
        let pool = test_pool().await;
        let app = app!(pool);
        let (a, b, c) = (user(&pool).await, user(&pool).await, user(&pool).await);
        let channel_id = channel(&pool, &[(&a, "admin"), (&b, "user"), (&c, "user")]).await;

        let resp = actix_test::call_service(&app, leave_req(&b, channel_id).to_request()).await;
        assert_eq!(resp.status(), StatusCode::OK, "a regular member can leave");
        assert_eq!(role_of(&pool, channel_id, b.id).await, None);

        let resp = actix_test::call_service(&app, leave_req(&a, channel_id).to_request()).await;
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "last admin with members stays"
        );

        let resp = actix_test::call_service(&app, leave_req(&c, channel_id).to_request()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let resp = actix_test::call_service(&app, leave_req(&a, channel_id).to_request()).await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "the last member may leave, emptying it"
        );

        let resp = actix_test::call_service(&app, leave_req(&a, channel_id).to_request()).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "no longer a member");
    }

    #[actix_web::test]
    async fn org_owner_recovers_only_a_channel_with_no_admin() {
        let pool = test_pool().await;
        let app = app!(pool);
        let (org_id, owner) = org_with_owner(&pool).await;
        let a = org_user(&pool, org_id, "organization", "member").await;
        let b = org_user(&pool, org_id, "organization", "member").await;
        let channel_id = channel(&pool, &[(&a, "admin"), (&b, "user")]).await;

        let resp = actix_test::call_service(
            &app,
            role_req(&owner, channel_id, &b.email, "admin").to_request(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "no override while an admin exists"
        );

        // Simulate a channel stranded before the fix.
        sqlx::query("UPDATE channel_members SET role = 'user' WHERE channel_id = $1")
            .bind(channel_id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("strand channel: {e}"));

        let normal = actix_test::TestRequest::patch()
            .uri(&format!("/chat/channels/{channel_id}/members/role"))
            .insert_header((
                "Authorization",
                format!(
                    "Bearer {}",
                    jwt_for_mode(owner.id, &owner.email, SessionMode::Normal)
                ),
            ))
            .set_json(serde_json::json!({ "email": b.email, "role": "admin" }))
            .to_request();
        let resp = actix_test::call_service(&app, normal).await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "recovery needs admin mode"
        );

        let list = actix_test::TestRequest::get()
            .uri("/chat/channels")
            .insert_header(bearer(&owner))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, list).await;
        let listed = body
            .as_array()
            .and_then(|all| {
                all.iter()
                    .find(|c| c["id"] == serde_json::json!(channel_id))
            })
            .unwrap_or_else(|| panic!("owner should list the org channel: {body}"));
        assert_eq!(listed["can_manage"], serde_json::json!(true));

        let resp = actix_test::call_service(
            &app,
            role_req(&owner, channel_id, &b.email, "admin").to_request(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "owner in admin mode recovers it"
        );
        assert_eq!(
            role_of(&pool, channel_id, b.id).await.as_deref(),
            Some("admin")
        );

        let resp = actix_test::call_service(
            &app,
            role_req(&owner, channel_id, &a.email, "admin").to_request(),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "override ends once it has an admin"
        );
    }

    #[actix_web::test]
    async fn deleting_the_creator_and_last_admin_hands_the_channel_off() {
        let pool = test_pool().await;
        let (a, b, c) = (user(&pool).await, user(&pool).await, user(&pool).await);
        let channel_id = channel(&pool, &[(&a, "admin"), (&b, "user"), (&c, "user")]).await;

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(a.id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("delete creator: {e}"));

        let created_by: Option<i32> =
            sqlx::query_scalar("SELECT created_by FROM channels WHERE id = $1")
                .bind(channel_id)
                .fetch_optional(&pool)
                .await
                .unwrap_or_else(|e| panic!("channel lookup: {e}"));
        assert_eq!(
            created_by,
            Some(b.id),
            "channel survives, owned by the longest member"
        );
        assert_eq!(
            role_of(&pool, channel_id, b.id).await.as_deref(),
            Some("admin")
        );
        assert_eq!(admin_count(&pool, channel_id).await, 1);
    }

    #[actix_web::test]
    async fn deleting_every_admin_in_one_statement_still_leaves_one() {
        let pool = test_pool().await;
        let (a, b, c) = (user(&pool).await, user(&pool).await, user(&pool).await);
        let channel_id = channel(&pool, &[(&a, "admin"), (&b, "admin"), (&c, "user")]).await;

        sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(vec![a.id, b.id])
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("bulk delete: {e}"));

        assert_eq!(
            role_of(&pool, channel_id, c.id).await.as_deref(),
            Some("admin")
        );
        assert_eq!(admin_count(&pool, channel_id).await, 1);
    }

    #[actix_web::test]
    async fn deleting_the_sole_member_still_removes_an_empty_channel() {
        let pool = test_pool().await;
        let a = user(&pool).await;
        let channel_id = channel(&pool, &[(&a, "admin")]).await;

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(a.id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("delete: {e}"));

        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM channels WHERE id = $1)")
                .bind(channel_id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("exists: {e}"));
        assert!(!exists, "no one is left to hand it to");
    }
}
