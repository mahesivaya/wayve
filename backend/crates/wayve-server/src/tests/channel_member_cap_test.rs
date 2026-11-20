// A channel always has fewer than 25 members (at most 24). Pins both layers:
// the `trg_channel_member_cap` trigger in init.sql (the guarantee, whatever the
// path) and the handlers' up-front checks (the clear 409), including an add
// batch that would overfill adding no one and two concurrent adds for the last
// seat letting exactly one in.
#[cfg(test)]
mod tests {
    use crate::chat::handler::{add_channel_users, create_channel, join_channel};
    use crate::test_support::{jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;

    const MAX: usize = 24;

    struct Member {
        id: i32,
        email: String,
    }

    // Plain rows, no password hashing: these tests need dozens of users.
    async fn users(pool: &PgPool, n: usize) -> Vec<Member> {
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let email = random_email();
            let id: i32 = sqlx::query_scalar(
                "INSERT INTO users (email, account_type, email_verified) \
                 VALUES ($1, 'personal', true) RETURNING id",
            )
            .bind(&email)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("insert user: {e}"));
            out.push(Member { id, email });
        }
        out
    }

    /// A channel whose first member is its admin.
    async fn channel(pool: &PgPool, visibility: &str, members: &[Member]) -> i32 {
        let channel_id: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by, visibility) VALUES ('cap', $1, $2) RETURNING id",
        )
        .bind(members[0].id)
        .bind(visibility)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("create channel: {e}"));
        for (i, m) in members.iter().enumerate() {
            sqlx::query(
                "INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, $3)",
            )
            .bind(channel_id)
            .bind(m.id)
            .bind(if i == 0 { "admin" } else { "user" })
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("add member: {e}"));
        }
        channel_id
    }

    async fn member_count(pool: &PgPool, channel_id: i32) -> usize {
        let n: i64 =
            sqlx::query_scalar("SELECT count(*) FROM channel_members WHERE channel_id = $1")
                .bind(channel_id)
                .fetch_one(pool)
                .await
                .unwrap_or_else(|e| panic!("count: {e}"));
        n as usize
    }

    fn bearer(m: &Member) -> (&'static str, String) {
        (
            "Authorization",
            format!("Bearer {}", jwt_for(m.id, &m.email)),
        )
    }

    fn add_req(admin: &Member, channel_id: i32, emails: &[&str]) -> actix_test::TestRequest {
        actix_test::TestRequest::post()
            .uri(&format!("/chat/channels/{channel_id}/members"))
            .insert_header(bearer(admin))
            .set_json(serde_json::json!({ "invite_emails": emails, "invite_role": "user" }))
    }

    macro_rules! app {
        ($pool:expr) => {
            actix_test::init_service(
                App::new()
                    .app_data(web::Data::new($pool.clone()))
                    .service(add_channel_users)
                    .service(create_channel)
                    .service(join_channel),
            )
            .await
        };
    }

    #[actix_web::test]
    async fn trigger_rejects_the_25th_member_on_any_path() {
        let pool = test_pool().await;
        let people = users(&pool, MAX + 1).await;
        let channel_id = channel(&pool, "private", &people[..MAX]).await;
        assert_eq!(member_count(&pool, channel_id).await, MAX);

        let err = sqlx::query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)")
            .bind(channel_id)
            .bind(people[MAX].id)
            .execute(&pool)
            .await
            .err()
            .unwrap_or_else(|| panic!("the 25th member must be rejected"));
        assert!(
            crate::chat::is_member_cap_violation(&err),
            "expected the member-cap constraint, got {err:?}"
        );

        // Re-adding someone already in a full channel is still a no-op, not an error.
        sqlx::query(
            "INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(channel_id)
        .bind(people[1].id)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("re-adding an existing member must pass: {e}"));
        assert_eq!(member_count(&pool, channel_id).await, MAX);
    }

    #[actix_web::test]
    async fn add_that_would_overfill_adds_no_one() {
        let pool = test_pool().await;
        let app = app!(pool);
        let people = users(&pool, MAX + 1).await;
        let channel_id = channel(&pool, "private", &people[..MAX - 2]).await;
        let admin = &people[0];
        let three: Vec<&str> = people[MAX - 2..].iter().map(|m| m.email.as_str()).collect();

        let res =
            actix_test::call_service(&app, add_req(admin, channel_id, &three).to_request()).await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let body: serde_json::Value = actix_test::read_body_json(res).await;
        assert_eq!(body["max_members"], 24);
        assert_eq!(
            member_count(&pool, channel_id).await,
            MAX - 2,
            "all or nothing"
        );

        // Two fit exactly; then the channel is full.
        let res =
            actix_test::call_service(&app, add_req(admin, channel_id, &three[..2]).to_request())
                .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(member_count(&pool, channel_id).await, MAX);
        let res =
            actix_test::call_service(&app, add_req(admin, channel_id, &three[2..]).to_request())
                .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        assert_eq!(member_count(&pool, channel_id).await, MAX);
    }

    #[actix_web::test]
    async fn two_adds_racing_for_the_last_seat_let_one_in() {
        let pool = test_pool().await;
        let app = app!(pool);
        for _ in 0..4 {
            let people = users(&pool, MAX + 1).await;
            let channel_id = channel(&pool, "private", &people[..MAX - 1]).await;
            let admin = &people[0];
            let (r1, r2) = tokio::join!(
                actix_test::call_service(
                    &app,
                    add_req(admin, channel_id, &[&people[MAX - 1].email]).to_request()
                ),
                actix_test::call_service(
                    &app,
                    add_req(admin, channel_id, &[&people[MAX].email]).to_request()
                ),
            );
            let statuses = [r1.status(), r2.status()];
            assert_eq!(
                statuses.iter().filter(|s| **s == StatusCode::OK).count(),
                1,
                "exactly one add wins: {statuses:?}"
            );
            assert_eq!(member_count(&pool, channel_id).await, MAX);
        }
    }

    #[actix_web::test]
    async fn joining_a_full_public_channel_is_refused() {
        let pool = test_pool().await;
        let app = app!(pool);
        let people = users(&pool, MAX + 1).await;
        let channel_id = channel(&pool, "public", &people[..MAX]).await;
        let outsider = &people[MAX];

        let req = actix_test::TestRequest::post()
            .uri(&format!("/chat/channels/{channel_id}/join"))
            .insert_header(bearer(outsider))
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            StatusCode::CONFLICT
        );
        assert_eq!(member_count(&pool, channel_id).await, MAX);
    }

    #[actix_web::test]
    async fn creating_a_channel_counts_the_creator() {
        let pool = test_pool().await;
        let app = app!(pool);
        let people = users(&pool, MAX + 1).await;
        let creator = &people[0];
        let create = |others: &[Member]| {
            actix_test::TestRequest::post()
                .uri("/chat/channels")
                .insert_header(bearer(creator))
                .set_json(serde_json::json!({
                    "name": "cap-create",
                    "member_ids": others.iter().map(|m| m.id).collect::<Vec<_>>(),
                }))
                .to_request()
        };

        // Creator + 24 others = 25: refused, and nothing is created.
        let res = actix_test::call_service(&app, create(&people[1..])).await;
        assert_eq!(res.status(), StatusCode::CONFLICT);

        // Creator + 23 others = 24: allowed, with all 24 seated.
        let res = actix_test::call_service(&app, create(&people[1..MAX])).await;
        assert_eq!(res.status(), StatusCode::CREATED);
        let body: serde_json::Value = actix_test::read_body_json(res).await;
        let channel_id = body["id"]
            .as_i64()
            .unwrap_or_else(|| panic!("created channel has no id: {body}"))
            as i32;
        assert_eq!(member_count(&pool, channel_id).await, MAX);
    }
}
