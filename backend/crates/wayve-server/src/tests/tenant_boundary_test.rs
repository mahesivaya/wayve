//! A permission says what a caller may do, not whose data they may do it to.
//! A personal account is the owner of its own scope and so holds every
//! permission; an organization's owner holds most of them for their own
//! workspace. Neither reaches another tenant's data through these endpoints.

#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    struct Account {
        id: i32,
        token: String,
    }

    async fn personal(pool: &PgPool) -> Account {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        Account {
            id,
            token: jwt_for(id, &email),
        }
    }

    async fn organization(pool: &PgPool) -> i32 {
        sqlx::query_scalar::<_, i32>("INSERT INTO organizations (name) VALUES ($1) RETURNING id")
            .bind(format!("Org {}", random_email()))
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert org: {e}"))
    }

    async fn org_member(pool: &PgPool, org_id: i32, role: &str) -> Account {
        let account = personal(pool).await;
        let account_type = if role == "owner" {
            "organization_admin"
        } else {
            "organization"
        };
        sqlx::query("UPDATE users SET account_type = $1, organization_id = $2 WHERE id = $3")
            .bind(account_type)
            .bind(org_id)
            .bind(account.id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("attach org: {e}"));
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, role) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(org_id)
        .bind(account.id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set org role: {e}"));
        account
    }

    async fn platform_staff(pool: &PgPool, role: &str) -> Account {
        let account = personal(pool).await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(account.id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, $2) \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(account.id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set platform role: {e}"));
        account
    }

    async fn cleanup(pool: &PgPool, accounts: &[&Account], org_ids: &[i32]) {
        for account in accounts {
            for sql in [
                "DELETE FROM api_keys WHERE user_id = $1 OR created_by = $1",
                "DELETE FROM platform_members WHERE user_id = $1",
                "DELETE FROM users WHERE id = $1",
            ] {
                let _ = sqlx::query(sql).bind(account.id).execute(pool).await;
            }
        }
        for org_id in org_ids {
            let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(org_id)
                .execute(pool)
                .await;
        }
    }

    fn bearer(account: &Account) -> (&'static str, String) {
        ("Authorization", format!("Bearer {}", account.token))
    }

    #[actix_web::test]
    async fn a_personal_account_can_only_issue_api_keys_for_itself() {
        let pool = test_pool().await;
        let attacker = personal(&pool).await;
        let victim = personal(&pool).await;
        let org_id = organization(&pool).await;
        let org_owner = org_member(&pool, org_id, "owner").await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::api_keys::create_api_key),
        )
        .await;
        let mint = |act_as: Option<i32>| {
            let expiry = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
            actix_test::TestRequest::post()
                .uri("/keys")
                .insert_header(bearer(&attacker))
                .set_json(serde_json::json!({
                    "name": "key",
                    "key_type": "external",
                    "scopes": ["notes:read"],
                    "expires_at": expiry,
                    "act_as_user_id": act_as,
                }))
                .to_request()
        };

        for target in [victim.id, org_owner.id] {
            let resp = actix_test::call_service(&app, mint(Some(target))).await;
            assert_eq!(
                resp.status(),
                StatusCode::FORBIDDEN,
                "a personal account must not issue a key acting as user {target}"
            );
        }
        let issued_for_others: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM api_keys WHERE created_by = $1 AND user_id <> $1",
        )
        .bind(attacker.id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("count keys: {e}"));
        assert_eq!(issued_for_others, 0);

        // Its own key is unaffected.
        let resp = actix_test::call_service(&app, mint(None)).await;
        assert_eq!(resp.status(), StatusCode::CREATED);

        cleanup(&pool, &[&attacker, &victim, &org_owner], &[org_id]).await;
    }

    #[actix_web::test]
    async fn only_platform_support_staff_read_other_peoples_support_tickets() {
        let pool = test_pool().await;
        let org_id = organization(&pool).await;
        let reporter = org_member(&pool, org_id, "member").await;
        let outsider = personal(&pool).await;
        let other_org = organization(&pool).await;
        let other_org_owner = org_member(&pool, other_org, "owner").await;
        let support = platform_staff(&pool, "support").await;

        let ticket_id = sqlx::query_scalar::<_, i32>(
            "INSERT INTO support_tickets (user_id, organization_id, subject, description) \
             VALUES ($1, $2, 'Cannot log in', 'Details only support should see') RETURNING id",
        )
        .bind(reporter.id)
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert ticket: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::routes::support::routes),
        )
        .await;
        let get = |account: &Account, uri: &str| {
            actix_test::TestRequest::get()
                .uri(uri)
                .insert_header(bearer(account))
                .to_request()
        };
        let ticket = format!("/support/tickets/{ticket_id}");
        let attachments = format!("/support/tickets/{ticket_id}/attachments");

        // A personal account, and the owner of an unrelated organization.
        for account in [&outsider, &other_org_owner] {
            for uri in [
                "/support/admin/tickets",
                ticket.as_str(),
                attachments.as_str(),
            ] {
                let resp = actix_test::call_service(&app, get(account, uri)).await;
                assert_eq!(
                    resp.status(),
                    StatusCode::FORBIDDEN,
                    "user {} must not read {uri}",
                    account.id
                );
            }
            let req = actix_test::TestRequest::patch()
                .uri(&format!("/support/admin/tickets/{ticket_id}"))
                .insert_header(bearer(account))
                .set_json(serde_json::json!({ "status": "closed" }))
                .to_request();
            assert_eq!(
                actix_test::call_service(&app, req).await.status(),
                StatusCode::FORBIDDEN
            );
        }

        // The reporter still reads their own ticket, and support staff read it.
        let resp = actix_test::call_service(&app, get(&reporter, &ticket)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        for uri in [
            "/support/admin/tickets",
            ticket.as_str(),
            attachments.as_str(),
        ] {
            let resp = actix_test::call_service(&app, get(&support, uri)).await;
            assert_eq!(resp.status(), StatusCode::OK, "support staff on {uri}");
        }

        cleanup(
            &pool,
            &[&reporter, &outsider, &other_org_owner, &support],
            &[org_id, other_org],
        )
        .await;
    }

    #[actix_web::test]
    async fn scim_tokens_belong_to_the_organization_they_are_for() {
        let pool = test_pool().await;
        let org_id = organization(&pool).await;
        let org_owner = org_member(&pool, org_id, "owner").await;
        let other_org = organization(&pool).await;
        let outsider = personal(&pool).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::scim::admin::routes),
        )
        .await;
        let mint = |account: &Account, organization_id: i32| {
            actix_test::TestRequest::post()
                .uri("/scim/tokens")
                .insert_header(bearer(account))
                .set_json(serde_json::json!({ "name": "idp", "organization_id": organization_id }))
                .to_request()
        };

        // A personal account: no organization, so no tokens at all.
        let resp = actix_test::call_service(&app, mint(&outsider, org_id)).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let req = actix_test::TestRequest::get()
            .uri("/scim/tokens")
            .insert_header(bearer(&outsider))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        // An organization's owner: their own organization only.
        let resp = actix_test::call_service(&app, mint(&org_owner, other_org)).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let resp = actix_test::call_service(&app, mint(&org_owner, org_id)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(resp).await;
        let token_id = body["id"].as_i64().unwrap_or_default();

        // The personal account cannot revoke it either.
        let req = actix_test::TestRequest::delete()
            .uri(&format!("/scim/tokens/{token_id}"))
            .insert_header(bearer(&outsider))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::FORBIDDEN
        );

        let tokens: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM scim_tokens WHERE organization_id = ANY($1)")
                .bind(vec![org_id, other_org])
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("count tokens: {e}"));
        assert_eq!(tokens, 1, "only the owner's own-organization token exists");

        let _ = sqlx::query("DELETE FROM scim_tokens WHERE organization_id = ANY($1)")
            .bind(vec![org_id, other_org])
            .execute(&pool)
            .await;
        cleanup(&pool, &[&org_owner, &outsider], &[org_id, other_org]).await;
    }

    #[actix_web::test]
    async fn an_organizations_channel_can_only_be_joined_by_its_members() {
        let pool = test_pool().await;
        let org_id = organization(&pool).await;
        let creator = org_member(&pool, org_id, "owner").await;
        let colleague = org_member(&pool, org_id, "member").await;
        let outsider = personal(&pool).await;
        let other_org = organization(&pool).await;
        let other_member = org_member(&pool, other_org, "member").await;

        let channel_id = sqlx::query_scalar::<_, i32>(
            "INSERT INTO channels (name, visibility, created_by) \
             VALUES ($1, 'public', $2) RETURNING id",
        )
        .bind(format!("general-{org_id}"))
        .bind(creator.id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert channel: {e}"));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .configure(crate::chat::routes),
        )
        .await;
        let join = |account: &Account| {
            actix_test::TestRequest::post()
                .uri(&format!("/chat/channels/{channel_id}/join"))
                .insert_header(bearer(account))
                .to_request()
        };
        let members = || async {
            sqlx::query_scalar::<_, i32>(
                "SELECT user_id FROM channel_members WHERE channel_id = $1 ORDER BY user_id",
            )
            .bind(channel_id)
            .fetch_all(&pool)
            .await
            .unwrap_or_else(|e| panic!("read members: {e}"))
        };

        // "Not found", so the channel's number reveals nothing.
        for account in [&outsider, &other_member] {
            let resp = actix_test::call_service(&app, join(account)).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        }
        assert!(members().await.is_empty());
        let requests: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM channel_join_requests WHERE channel_id = $1")
                .bind(channel_id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("count requests: {e}"));
        assert_eq!(requests, 0);

        let resp = actix_test::call_service(&app, join(&colleague)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(members().await, vec![colleague.id]);

        let _ = sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(channel_id)
            .execute(&pool)
            .await;
        cleanup(
            &pool,
            &[&creator, &colleague, &outsider, &other_member],
            &[org_id, other_org],
        )
        .await;
    }
}
