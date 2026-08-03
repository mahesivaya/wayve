// Personal accounts do not form a tenant. `GET /chat/channels` used to match on
// `creator.account_type = 'personal'` alone, which listed every channel created
// by any personal account on the instance to every other personal account —
// private ones included, along with their member and invite email arrays. These
// tests pin the relational rule that replaced it: a personal caller sees only
// channels they belong to, created, were invited to, or have a pending join
// request for.

#[cfg(test)]
mod tests {
    use crate::chat::handler::get_channels;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, test as actix_test, web};
    use sqlx::PgPool;

    async fn make_channel(pool: &PgPool, name: &str, creator: i32, visibility: &str) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO channels (name, created_by, visibility)
             VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(name)
        .bind(creator)
        .bind(visibility)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("create channel: {e}"))
    }

    async fn add_member(pool: &PgPool, channel_id: i32, user_id: i32) {
        sqlx::query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)")
            .bind(channel_id)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("add member: {e}"));
    }

    async fn listed_channel_ids(pool: &PgPool, user_id: i32, email: &str) -> Vec<i64> {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(get_channels),
        )
        .await;

        let req = actix_test::TestRequest::get()
            .uri("/chat/channels")
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, email)),
            ))
            .to_request();
        let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;

        body.as_array()
            .unwrap_or_else(|| panic!("expected an array, got {body}"))
            .iter()
            .filter_map(|c| c.get("id").and_then(|v| v.as_i64()))
            .collect()
    }

    #[actix_web::test]
    async fn personal_caller_sees_only_their_own_channels() {
        let pool = test_pool().await;

        let caller_email = random_email();
        let caller = insert_local_user(&pool, &caller_email, "password123").await;
        let other_email = random_email();
        let other = insert_local_user(&pool, &other_email, "password123").await;

        // Belongs to the caller.
        let mine = make_channel(&pool, &format!("mine-{caller}"), other, "private").await;
        add_member(&pool, mine, caller).await;

        // Created by the caller but with no membership row yet.
        let authored = make_channel(&pool, &format!("authored-{caller}"), caller, "private").await;

        // Another personal account's channels — one private, one public. Neither
        // is discoverable, because no tenant links the two accounts.
        let stranger_private =
            make_channel(&pool, &format!("stranger-priv-{other}"), other, "private").await;
        let stranger_public =
            make_channel(&pool, &format!("stranger-pub-{other}"), other, "public").await;

        let ids = listed_channel_ids(&pool, caller, &caller_email).await;

        assert!(ids.contains(&(mine as i64)), "member channel missing");
        assert!(ids.contains(&(authored as i64)), "authored channel missing");
        assert!(
            !ids.contains(&(stranger_private as i64)),
            "another personal account's PRIVATE channel leaked"
        );
        assert!(
            !ids.contains(&(stranger_public as i64)),
            "another personal account's public channel leaked"
        );

        for cid in [mine, authored, stranger_private, stranger_public] {
            let _ = sqlx::query("DELETE FROM channels WHERE id = $1")
                .bind(cid)
                .execute(&pool)
                .await;
        }
        for uid in [caller, other] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
        }
    }

    #[actix_web::test]
    async fn personal_caller_sees_a_channel_they_were_invited_to() {
        let pool = test_pool().await;

        let caller_email = random_email();
        let caller = insert_local_user(&pool, &caller_email, "password123").await;
        let host_email = random_email();
        let host = insert_local_user(&pool, &host_email, "password123").await;

        let invited = make_channel(&pool, &format!("invited-{caller}"), host, "private").await;
        // Invites are keyed by email, and are matched case-insensitively so an
        // invite addressed differently than the stored address still resolves.
        sqlx::query("INSERT INTO channel_invites (channel_id, email) VALUES ($1, $2)")
            .bind(invited)
            .bind(caller_email.to_uppercase())
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("invite: {e}"));

        let ids = listed_channel_ids(&pool, caller, &caller_email).await;
        assert!(
            ids.contains(&(invited as i64)),
            "channel the caller was invited to by email is missing"
        );

        let _ = sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(invited)
            .execute(&pool)
            .await;
        for uid in [caller, host] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
        }
    }
}
