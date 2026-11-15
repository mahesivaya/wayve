// Platform Analytics "Top organizations": the mailboxes column counts the
// mailboxes of the organization's members. `email_accounts.organization_id` is
// only set when a mailbox is shared, so ordinary member mailboxes must still
// count, and a non-member's mailbox must not.
#[cfg(test)]
mod tests {
    use crate::platform_team::handler::support_summary;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    async fn make_platform_owner(pool: &PgPool, email: &str) -> i32 {
        let id = insert_local_user(pool, email, "password123").await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query(
            "INSERT INTO platform_members (user_id, role) VALUES ($1, 'owner') \
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap_or_else(|e| panic!("set platform owner: {e}"));
        id
    }

    async fn insert_user(pool: &PgPool, organization_id: Option<i32>) -> i32 {
        // No password hashing: these users never sign in.
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO users (email, password, organization_id) VALUES ($1, 'x', $2) RETURNING id",
        )
        .bind(random_email())
        .bind(organization_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert user: {e}"))
    }

    async fn insert_mailbox(pool: &PgPool, user_id: i32) -> i32 {
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'imap') RETURNING id",
        )
        .bind(random_email())
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert mailbox: {e}"))
    }

    #[actix_web::test]
    async fn top_organizations_count_members_mailboxes() {
        let pool = test_pool().await;
        let owner_email = random_email();
        let owner_id = make_platform_owner(&pool, &owner_email).await;

        let org_id = sqlx::query_scalar::<_, i32>(
            "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
        )
        .bind(format!("Analytics {}", random_email()))
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert org: {e}"));

        // The list is the 10 largest organizations, so make this one large
        // enough to be among them.
        let mut users = Vec::new();
        for _ in 0..40 {
            users.push(insert_user(&pool, Some(org_id)).await);
        }
        let outsider = insert_user(&pool, None).await;
        users.push(outsider);

        // Two members' ordinary mailboxes (organization_id stays NULL) count;
        // the outsider's does not.
        let mailboxes = vec![
            insert_mailbox(&pool, users[0]).await,
            insert_mailbox(&pool, users[1]).await,
            insert_mailbox(&pool, outsider).await,
        ];

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(support_summary),
        )
        .await;
        let token = jwt_for(owner_id, &owner_email);
        let req = actix_test::TestRequest::get()
            .uri("/platform-team/support-summary")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        let status = resp.status();
        let body: serde_json::Value = actix_test::read_body_json(resp).await;

        for id in &mailboxes {
            let _ = sqlx::query("DELETE FROM email_accounts WHERE id = $1")
                .bind(id)
                .execute(&pool)
                .await;
        }
        for id in users.iter().chain(std::iter::once(&owner_id)) {
            let _ = sqlx::query("DELETE FROM platform_members WHERE user_id = $1")
                .bind(id)
                .execute(&pool)
                .await;
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(id)
                .execute(&pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(&pool)
            .await;

        assert_eq!(status, StatusCode::OK);
        let row = body["top_organizations"]
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["id"] == org_id))
            .unwrap_or_else(|| panic!("org {org_id} not in top organizations: {body}"));
        assert_eq!(row["member_count"], 40);
        assert_eq!(row["mailboxes"], 2);
    }
}
