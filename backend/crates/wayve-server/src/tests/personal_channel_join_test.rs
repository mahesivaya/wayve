//! Personal accounts share no tenant, so one cannot reach another's channel
//! just by being a personal account. The channel's creator decides: a public
//! channel is open to any personal account that has its number, and a private
//! one only to an email address the creator invited. New personal channels are
//! private unless public is asked for.

#[cfg(test)]
mod tests {
    use crate::chat::helpers::channel_visibility_for;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wayve_security::rbac::Scope;

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

    async fn channel(pool: &PgPool, creator: &Account, visibility: &str) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO channels (name, visibility, created_by) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(format!("ch-{}", random_email()))
        .bind(visibility)
        .bind(creator.id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert channel: {e}"))
    }

    async fn members(pool: &PgPool, channel_id: i32) -> Vec<i32> {
        sqlx::query_scalar(
            "SELECT user_id FROM channel_members WHERE channel_id = $1 ORDER BY user_id",
        )
        .bind(channel_id)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("read members: {e}"))
    }

    async fn pending_requests(pool: &PgPool, channel_id: i32) -> Vec<i32> {
        sqlx::query_scalar(
            "SELECT user_id FROM channel_join_requests WHERE channel_id = $1 ORDER BY user_id",
        )
        .bind(channel_id)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("read requests: {e}"))
    }

    async fn cleanup(pool: &PgPool, channels: &[i32], accounts: &[&Account], orgs: &[i32]) {
        let _ = sqlx::query("DELETE FROM channels WHERE id = ANY($1)")
            .bind(channels.to_vec())
            .execute(pool)
            .await;
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

    #[test]
    fn a_personal_channel_is_private_unless_public_is_asked_for() {
        assert_eq!(channel_visibility_for(Scope::Personal, None), "private");
        assert_eq!(
            channel_visibility_for(Scope::Personal, Some("private")),
            "private"
        );
        assert_eq!(
            channel_visibility_for(Scope::Personal, Some("anything else")),
            "private"
        );
        assert_eq!(
            channel_visibility_for(Scope::Personal, Some("public")),
            "public"
        );
        // Organizations and the platform have no choice.
        for scope in [Scope::Organization, Scope::Platform] {
            assert_eq!(channel_visibility_for(scope, Some("private")), "public");
            assert_eq!(channel_visibility_for(scope, None), "public");
        }
    }

    #[actix_web::test]
    async fn a_personal_account_creates_a_private_channel_when_it_does_not_choose() {
        let pool = test_pool().await;
        let creator = personal(&pool).await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::chat::handler::create_channel),
        )
        .await;
        let create = |body: serde_json::Value| {
            actix_test::TestRequest::post()
                .uri("/chat/channels")
                .insert_header(("Authorization", format!("Bearer {}", creator.token)))
                .set_json(body)
                .to_request()
        };
        let mut made = Vec::new();
        for (body, expected) in [
            (serde_json::json!({ "name": "no choice" }), "private"),
            (
                serde_json::json!({ "name": "asked", "visibility": "public" }),
                "public",
            ),
        ] {
            let resp: serde_json::Value =
                actix_test::call_and_read_body_json(&app, create(body)).await;
            let id = resp["id"]
                .as_i64()
                .unwrap_or_else(|| panic!("expected a channel id, got {resp}"))
                as i32;
            let stored: String =
                sqlx::query_scalar("SELECT visibility FROM channels WHERE id = $1")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap_or_else(|e| panic!("read channel: {e}"));
            assert_eq!(stored, expected);
            made.push(id);
        }
        cleanup(&pool, &made, &[&creator], &[]).await;
    }

    #[actix_web::test]
    async fn another_persons_channel_is_reached_only_if_public_or_invited() {
        let pool = test_pool().await;
        let creator = personal(&pool).await;
        let stranger = personal(&pool).await;
        let invited = personal(&pool).await;
        let (org_user, org_id) = org_member(&pool).await;

        let public_channel = channel(&pool, &creator, "public").await;
        let private_channel = channel(&pool, &creator, "private").await;
        // Invited by address, in a different letter case than they signed up with.
        sqlx::query(
            "INSERT INTO channel_invites (channel_id, email, role, invited_by) \
             VALUES ($1, $2, 'user', $3)",
        )
        .bind(private_channel)
        .bind(invited.email.to_uppercase())
        .bind(creator.id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert invite: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::chat::routes),
        )
        .await;
        let join = |account: &Account, channel_id: i32| {
            actix_test::TestRequest::post()
                .uri(&format!("/chat/channels/{channel_id}/join"))
                .insert_header(("Authorization", format!("Bearer {}", account.token)))
                .to_request()
        };

        // Private: a stranger gets "not found", and leaves no trace — not even a
        // join request the creator would have to turn down.
        let resp = actix_test::call_service(&app, join(&stranger, private_channel)).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(members(&pool, private_channel).await.is_empty());
        assert!(pending_requests(&pool, private_channel).await.is_empty());

        // Private: the invited address may ask to join, as before.
        let resp = actix_test::call_service(&app, join(&invited, private_channel)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            pending_requests(&pool, private_channel).await,
            vec![invited.id]
        );
        assert!(members(&pool, private_channel).await.is_empty());

        // Public, by the creator's choice: another personal account joins.
        let resp = actix_test::call_service(&app, join(&stranger, public_channel)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(members(&pool, public_channel).await, vec![stranger.id]);

        // Public to personal accounts only: an organization's member is still
        // outside it.
        for channel_id in [public_channel, private_channel] {
            let resp = actix_test::call_service(&app, join(&org_user, channel_id)).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        }
        assert_eq!(members(&pool, public_channel).await, vec![stranger.id]);

        cleanup(
            &pool,
            &[public_channel, private_channel],
            &[&creator, &stranger, &invited, &org_user],
            &[org_id],
        )
        .await;
    }
}
