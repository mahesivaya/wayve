//! `inbox:manage` lets an admin publish shared inboxes; it does not let them
//! publish someone else's mailbox. Sharing a mailbox and then adding yourself
//! as a member grants read and reply on it, so only its owner may share it.

#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    struct Account {
        id: i32,
        token: String,
    }

    async fn user(pool: &PgPool) -> Account {
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
        let account = user(pool).await;
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
             VALUES ($1, $2, $3)",
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
        let account = user(pool).await;
        sqlx::query("UPDATE users SET account_type = 'platform_admin' WHERE id = $1")
            .bind(account.id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform_admin: {e}"));
        sqlx::query("INSERT INTO platform_members (user_id, role) VALUES ($1, $2)")
            .bind(account.id)
            .bind(role)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("set platform role: {e}"));
        account
    }

    async fn mailbox(pool: &PgPool, owner: &Account) -> i32 {
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO email_accounts (email, user_id, provider) \
             VALUES ($1, $2, 'imap') RETURNING id",
        )
        .bind(random_email())
        .bind(owner.id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert mailbox: {e}"))
    }

    /// `(is_shared, organization_id)` as stored.
    async fn sharing(pool: &PgPool, account_id: i32) -> (bool, Option<i32>) {
        sqlx::query_as("SELECT is_shared, organization_id FROM email_accounts WHERE id = $1")
            .bind(account_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("read mailbox: {e}"))
    }

    async fn cleanup(pool: &PgPool, accounts: &[&Account], org_ids: &[i32]) {
        for account in accounts {
            for sql in [
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

    #[actix_web::test]
    async fn only_the_owner_of_a_mailbox_can_share_it() {
        let pool = test_pool().await;
        let org_a = organization(&pool).await;
        let org_b = organization(&pool).await;
        let admin_a = org_member(&pool, org_a, "admin").await;
        let colleague_a = org_member(&pool, org_a, "member").await;
        let member_b = org_member(&pool, org_b, "member").await;
        let outsider = user(&pool).await;
        let staff = platform_staff(&pool, "owner").await;

        let other_org_box = mailbox(&pool, &member_b).await;
        let personal_box = mailbox(&pool, &outsider).await;
        let colleague_box = mailbox(&pool, &colleague_a).await;
        let own_box = mailbox(&pool, &admin_a).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(crate::routes::shared_inbox::create_shared_inbox)
                .service(crate::routes::shared_inbox::add_inbox_member),
        )
        .await;
        let share = |caller: &Account, account_id: i32, organization_id: Option<i32>| {
            actix_test::TestRequest::post()
                .uri("/shared-inboxes")
                .insert_header(("Authorization", format!("Bearer {}", caller.token)))
                .set_json(serde_json::json!({
                    "account_id": account_id,
                    "label": "Support",
                    "organization_id": organization_id,
                }))
                .to_request()
        };

        // An org admin claiming a mailbox into their own org: another org's,
        // a personal account's, and a colleague's are all refused.
        for (whose, account_id) in [
            ("another organization's", other_org_box),
            ("a personal account's", personal_box),
            ("a colleague's", colleague_box),
        ] {
            let resp =
                actix_test::call_service(&app, share(&admin_a, account_id, Some(org_a))).await;
            assert_eq!(
                resp.status(),
                StatusCode::NOT_FOUND,
                "an org admin must not share {whose} mailbox"
            );
            assert_eq!(
                sharing(&pool, account_id).await,
                (false, None),
                "{whose} mailbox must be left untouched"
            );

            // With the share refused there is no inbox to join either.
            let join = actix_test::TestRequest::post()
                .uri(&format!("/shared-inboxes/{account_id}/members"))
                .insert_header(("Authorization", format!("Bearer {}", admin_a.token)))
                .set_json(serde_json::json!({ "user_id": admin_a.id }))
                .to_request();
            let resp = actix_test::call_service(&app, join).await;
            assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        }
        let members: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM shared_inbox_members WHERE user_id = $1")
                .bind(admin_a.id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("count members: {e}"));
        assert_eq!(members, 0, "the admin gained no mailbox access");

        // Platform staff hold the permission for every scope, and still can't
        // publish a mailbox that isn't theirs.
        for organization_id in [None, Some(org_b)] {
            let resp =
                actix_test::call_service(&app, share(&staff, other_org_box, organization_id)).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        }
        assert_eq!(sharing(&pool, other_org_box).await, (false, None));

        // Nor can they add themselves to a mailbox nobody has shared.
        let join = actix_test::TestRequest::post()
            .uri(&format!("/shared-inboxes/{personal_box}/members"))
            .insert_header(("Authorization", format!("Bearer {}", staff.token)))
            .set_json(serde_json::json!({ "user_id": staff.id }))
            .to_request();
        let resp = actix_test::call_service(&app, join).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let members: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM shared_inbox_members WHERE user_id = $1")
                .bind(staff.id)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("count members: {e}"));
        assert_eq!(members, 0, "platform staff gained no mailbox access");

        // The owner sharing their own mailbox into their own org still works.
        let resp = actix_test::call_service(&app, share(&admin_a, own_box, Some(org_a))).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(sharing(&pool, own_box).await, (true, Some(org_a)));

        cleanup(
            &pool,
            &[&admin_a, &colleague_a, &member_b, &outsider, &staff],
            &[org_a, org_b],
        )
        .await;
    }
}
