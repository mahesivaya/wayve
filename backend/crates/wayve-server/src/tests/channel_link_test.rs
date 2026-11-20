//! A channel link (`/chat?c=<id>&t=<link_token>`) shows a preview before
//! joining. The preview is open to exactly the people the channel itself is
//! open to: the tenant it belongs to, or, for a personal account's channel, a
//! personal account holding its link when it is public and only invited
//! addresses when it is private. Everyone else gets "not found", the same as
//! for a number that doesn't exist, so walking channel ids finds nothing.

#[cfg(test)]
mod tests {
    use crate::chat::handler::{
        approve_channel_join_request, get_channel_preview, get_channels, join_channel,
    };
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    struct Account {
        id: i32,
        email: String,
        token: String,
    }

    async fn personal(pool: &PgPool) -> Account {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        let token = jwt_for(id, &email);
        Account { id, email, token }
    }

    async fn org_member(pool: &PgPool) -> (Account, i32) {
        let account = personal(pool).await;
        let org_id: i32 =
            sqlx::query_scalar("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
                .bind(format!("Org {}", account.email))
                .fetch_one(pool)
                .await
                .unwrap_or_else(|e| panic!("insert org: {e}"));
        sqlx::query(
            "UPDATE users SET organization_id = $1, account_type = 'organization' WHERE id = $2",
        )
        .bind(org_id)
        .bind(account.id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("join org: {e}"));
        wayve_security::rbac::invalidate_role_context(account.id).await;
        (account, org_id)
    }

    /// A channel with its creator as the one member.
    async fn channel(pool: &PgPool, creator: &Account, visibility: &str) -> i32 {
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, visibility, created_by) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(format!("ch-{}", creator.email))
        .bind(visibility)
        .bind(creator.id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert channel: {e}"));
        sqlx::query(
            "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'admin')",
        )
        .bind(id)
        .bind(creator.id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("insert member: {e}"));
        id
    }

    async fn request(
        pool: &PgPool,
        who: &Account,
        request: actix_test::TestRequest,
    ) -> (StatusCode, serde_json::Value) {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_channel_preview)
                .service(join_channel)
                .service(get_channels)
                .service(approve_channel_join_request),
        )
        .await;
        let res = actix_test::call_service(
            &app,
            request
                .insert_header(("Authorization", format!("Bearer {}", who.token)))
                .to_request(),
        )
        .await;
        let status = res.status();
        let bytes = actix_test::read_body(res).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    async fn link_token(pool: &PgPool, channel_id: i32) -> String {
        sqlx::query_scalar("SELECT link_token FROM channels WHERE id = $1")
            .bind(channel_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("read link token: {e}"))
    }

    fn query(token: Option<&str>) -> String {
        token.map(|t| format!("?t={t}")).unwrap_or_default()
    }

    async fn preview_with(
        pool: &PgPool,
        who: &Account,
        channel_id: i32,
        token: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        request(
            pool,
            who,
            actix_test::TestRequest::get().uri(&format!(
                "/chat/channels/{channel_id}/preview{}",
                query(token)
            )),
        )
        .await
    }

    async fn preview(
        pool: &PgPool,
        who: &Account,
        channel_id: i32,
    ) -> (StatusCode, serde_json::Value) {
        preview_with(pool, who, channel_id, None).await
    }

    async fn join_with(
        pool: &PgPool,
        who: &Account,
        channel_id: i32,
        token: Option<&str>,
    ) -> StatusCode {
        request(
            pool,
            who,
            actix_test::TestRequest::post()
                .uri(&format!("/chat/channels/{channel_id}/join{}", query(token))),
        )
        .await
        .0
    }

    async fn join(pool: &PgPool, who: &Account, channel_id: i32) -> StatusCode {
        join_with(pool, who, channel_id, None).await
    }

    /// The caller's row for `channel_id` in `GET /chat/channels`, if listed.
    async fn listed(pool: &PgPool, who: &Account, channel_id: i32) -> Option<serde_json::Value> {
        let (status, body) = request(
            pool,
            who,
            actix_test::TestRequest::get().uri("/chat/channels"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        body.as_array()
            .and_then(|rows| rows.iter().find(|c| c["id"] == channel_id).cloned())
    }

    async fn cleanup(pool: &PgPool, accounts: &[&Account], orgs: &[i32]) {
        for account in accounts {
            let _ = sqlx::query("DELETE FROM channels WHERE created_by = $1")
                .bind(account.id)
                .execute(pool)
                .await;
        }
        for account in accounts {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(account.id)
                .execute(pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM organizations WHERE id = ANY($1)")
            .bind(orgs.to_vec())
            .execute(pool)
            .await;
    }

    #[actix_web::test]
    async fn a_personal_public_channel_previews_only_with_its_link() {
        let pool = test_pool().await;
        let creator = personal(&pool).await;
        let stranger = personal(&pool).await;
        let id = channel(&pool, &creator, "public").await;
        let token = link_token(&pool, id).await;

        // The number alone, or the number with a wrong or another channel's
        // token, reads as no channel at all: ids are sequential, so they are no
        // secret.
        let other = channel(&pool, &stranger, "public").await;
        let other_token = link_token(&pool, other).await;
        for wrong in [
            None,
            Some(""),
            Some("not-the-token"),
            Some(other_token.as_str()),
        ] {
            assert_eq!(
                preview_with(&pool, &stranger, id, wrong).await.0,
                StatusCode::NOT_FOUND,
                "token {wrong:?}"
            );
            assert_eq!(
                join_with(&pool, &stranger, id, wrong).await,
                StatusCode::NOT_FOUND,
                "token {wrong:?}"
            );
        }

        let (status, body) = preview_with(&pool, &stranger, id, Some(&token)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], id);
        assert_eq!(body["name"], format!("ch-{}", creator.email));
        assert_eq!(body["visibility"], "public");
        assert_eq!(body["is_member"], false);
        assert_eq!(body["join_status"], serde_json::Value::Null);
        // How many, not who.
        assert_eq!(body["member_count"], 1);
        assert_eq!(body["member_emails"], serde_json::json!([]));
        assert_eq!(body["member_ids"], serde_json::json!([]));
        // The name above carries the creator's address by construction;
        // nothing else in the body may.
        assert_eq!(body.to_string().matches(&creator.email).count(), 1);

        // The link leads to a join, and the preview follows (a member needs no
        // token).
        assert_eq!(
            join_with(&pool, &stranger, id, Some(&token)).await,
            StatusCode::OK
        );
        let (status, body) = preview(&pool, &stranger, id).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["is_member"], true);
        assert_eq!(body["member_count"], 2);

        cleanup(&pool, &[&creator, &stranger], &[]).await;
    }

    #[actix_web::test]
    async fn a_personal_private_channel_previews_only_for_an_invited_address() {
        let pool = test_pool().await;
        let creator = personal(&pool).await;
        let stranger = personal(&pool).await;
        let invited = personal(&pool).await;
        let id = channel(&pool, &creator, "private").await;
        sqlx::query(
            "INSERT INTO channel_invites (channel_id, email, role) VALUES ($1, $2, 'user')",
        )
        .bind(id)
        .bind(invited.email.to_uppercase())
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert invite: {e}"));

        assert_eq!(preview(&pool, &stranger, id).await.0, StatusCode::NOT_FOUND);

        let (status, body) = preview(&pool, &invited, id).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["visibility"], "private");
        // Asking to join shows on the next look.
        assert_eq!(join(&pool, &invited, id).await, StatusCode::OK);
        let (_, body) = preview(&pool, &invited, id).await;
        assert_eq!(body["is_member"], false);
        assert_eq!(body["join_status"], "pending");

        cleanup(&pool, &[&creator, &stranger, &invited], &[]).await;
    }

    #[actix_web::test]
    async fn an_organization_channel_previews_only_inside_the_organization() {
        let pool = test_pool().await;
        let (creator, org) = org_member(&pool).await;
        let (outsider, other_org) = org_member(&pool).await;
        let stranger = personal(&pool).await;
        let colleague = personal(&pool).await;
        sqlx::query(
            "UPDATE users SET organization_id = $1, account_type = 'organization' WHERE id = $2",
        )
        .bind(org)
        .bind(colleague.id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("join org: {e}"));
        wayve_security::rbac::invalidate_role_context(colleague.id).await;
        let id = channel(&pool, &creator, "public").await;

        assert_eq!(preview(&pool, &colleague, id).await.0, StatusCode::OK);
        for who in [&outsider, &stranger] {
            assert_eq!(preview(&pool, who, id).await.0, StatusCode::NOT_FOUND);
        }
        // A number that was never a channel reads the same.
        assert_eq!(
            preview(&pool, &stranger, i32::MAX).await.0,
            StatusCode::NOT_FOUND
        );

        cleanup(
            &pool,
            &[&creator, &outsider, &stranger, &colleague],
            &[org, other_org],
        )
        .await;
    }

    #[actix_web::test]
    async fn only_members_are_given_a_channels_link_token() {
        let pool = test_pool().await;
        let creator = personal(&pool).await;
        let invited = personal(&pool).await;
        let id = channel(&pool, &creator, "private").await;
        sqlx::query(
            "INSERT INTO channel_invites (channel_id, email, role) VALUES ($1, $2, 'user')",
        )
        .bind(id)
        .bind(&invited.email)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert invite: {e}"));

        let token = link_token(&pool, id).await;
        assert_eq!(token.len(), 32);
        let mine = listed(&pool, &creator, id).await;
        assert_eq!(mine.map(|c| c["link_token"].clone()), Some(token.into()));
        // Invited, so listed, but not a member: no token to pass on.
        let theirs = listed(&pool, &invited, id).await;
        assert_eq!(
            theirs.map(|c| c["link_token"].clone()),
            Some(serde_json::Value::Null)
        );

        cleanup(&pool, &[&creator, &invited], &[]).await;
    }

    #[actix_web::test]
    async fn approving_needs_a_pending_join_request() {
        let pool = test_pool().await;
        let creator = personal(&pool).await;
        let invited = personal(&pool).await;
        let stranger = personal(&pool).await;
        let id = channel(&pool, &creator, "private").await;
        sqlx::query(
            "INSERT INTO channel_invites (channel_id, email, role) VALUES ($1, $2, 'user')",
        )
        .bind(id)
        .bind(&invited.email)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert invite: {e}"));
        let approve = |user_id: i32| {
            actix_test::TestRequest::post()
                .uri(&format!("/chat/channels/{id}/join-requests/approve"))
                .set_json(serde_json::json!({ "user_id": user_id }))
        };
        let is_member = |user_id: i32| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM channel_members \
                     WHERE channel_id = $1 AND user_id = $2)",
                )
                .bind(id)
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("read membership: {e}"))
            }
        };

        // Nobody asked: the admin can't pull an arbitrary account in.
        assert_eq!(
            request(&pool, &creator, approve(stranger.id)).await.0,
            StatusCode::NOT_FOUND
        );
        assert!(!is_member(stranger.id).await);

        // Asked: approved.
        assert_eq!(join(&pool, &invited, id).await, StatusCode::OK);
        assert_eq!(
            request(&pool, &creator, approve(invited.id)).await.0,
            StatusCode::OK
        );
        assert!(is_member(invited.id).await);

        cleanup(&pool, &[&creator, &invited, &stranger], &[]).await;
    }

    #[actix_web::test]
    async fn a_preview_needs_a_login() {
        let pool = test_pool().await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_channel_preview),
        )
        .await;
        let res = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/chat/channels/1/preview")
                .to_request(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
