//! Opening a direct conversation marks messages read for the person who opened
//! it, and nobody else. The two ids in the request are only "the two people in
//! this conversation": either may come first, so which messages are marked is
//! decided by who is signed in, never by position.

#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use wayve_security::encryption::encrypt;

    struct Person {
        id: i32,
        token: String,
    }

    async fn person(pool: &PgPool) -> Person {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        Person {
            id,
            token: jwt_for(id, &email),
        }
    }

    /// A stored direct message, unread.
    async fn message(pool: &PgPool, from: &Person, to: &Person) -> i32 {
        let (iv, ciphertext) = encrypt("hello").unwrap_or_else(|e| panic!("encrypt: {e}"));
        sqlx::query_scalar(
            "INSERT INTO messages (sender_id, receiver_id, content_encrypted, content_iv) \
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(from.id)
        .bind(to.id)
        .bind(ciphertext)
        .bind(iv)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert message: {e}"))
    }

    async fn status(pool: &PgPool, message_id: i32) -> String {
        sqlx::query_scalar("SELECT status::TEXT FROM messages WHERE id = $1")
            .bind(message_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("read status: {e}"))
    }

    async fn cleanup(pool: &PgPool, people: &[&Person]) {
        for p in people {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(p.id)
                .execute(pool)
                .await;
        }
    }

    #[actix_web::test]
    async fn opening_a_conversation_marks_only_the_callers_incoming_messages_read() {
        let pool = test_pool().await;
        let alice = person(&pool).await;
        let bob = person(&pool).await;
        let carol = person(&pool).await;

        let to_alice = message(&pool, &bob, &alice).await;
        let to_bob = message(&pool, &alice, &bob).await;
        let from_carol = message(&pool, &carol, &alice).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .configure(crate::chat::routes),
        )
        .await;
        let open = |caller: &Person, user1: i32, user2: i32| {
            actix_test::TestRequest::get()
                .uri(&format!(
                    "/chat/direct-messages?user1={user1}&user2={user2}"
                ))
                .insert_header(("Authorization", format!("Bearer {}", caller.token)))
                .to_request()
        };

        // Alice opens the conversation naming Bob first. That is a legitimate
        // way to name the same conversation, and before the fix it marked the
        // message Alice SENT as read by Bob, who had not opened anything.
        let resp = actix_test::call_service(&app, open(&alice, bob.id, alice.id)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            status(&pool, to_bob).await,
            "sent",
            "a sender must not be able to mark their own message as read"
        );
        assert_eq!(
            status(&pool, to_alice).await,
            "read",
            "what the caller received is what gets marked"
        );
        // Another conversation of Alice's is untouched.
        assert_eq!(status(&pool, from_carol).await, "sent");

        // The usual order gives the same result for the other person: Bob
        // opening it marks what Bob received, in either order.
        for (user1, user2) in [(alice.id, bob.id), (bob.id, alice.id)] {
            sqlx::query("UPDATE messages SET status = 'sent' WHERE id = $1")
                .bind(to_bob)
                .execute(&pool)
                .await
                .unwrap_or_else(|e| panic!("reset status: {e}"));
            let resp = actix_test::call_service(&app, open(&bob, user1, user2)).await;
            assert_eq!(resp.status(), StatusCode::OK);
            assert_eq!(status(&pool, to_bob).await, "read");
        }

        // Someone outside the conversation still can't open it, and marks nothing.
        let resp = actix_test::call_service(&app, open(&carol, alice.id, bob.id)).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(status(&pool, from_carol).await, "sent");

        cleanup(&pool, &[&alice, &bob, &carol]).await;
    }

    #[actix_web::test]
    async fn the_history_comes_back_whichever_way_the_conversation_is_named() {
        let pool = test_pool().await;
        let alice = person(&pool).await;
        let bob = person(&pool).await;
        let first = message(&pool, &bob, &alice).await;
        let second = message(&pool, &alice, &bob).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .configure(crate::chat::routes),
        )
        .await;
        for (user1, user2) in [(alice.id, bob.id), (bob.id, alice.id)] {
            let req = actix_test::TestRequest::get()
                .uri(&format!(
                    "/chat/direct-messages?user1={user1}&user2={user2}"
                ))
                .insert_header(("Authorization", format!("Bearer {}", alice.token)))
                .to_request();
            let body: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
            let mut ids: Vec<i64> = body
                .as_array()
                .unwrap_or_else(|| panic!("expected a list, got {body}"))
                .iter()
                .filter_map(|m| m["message_id"].as_i64().or_else(|| m["id"].as_i64()))
                .collect();
            ids.sort_unstable();
            assert_eq!(ids, vec![first as i64, second as i64]);
        }

        cleanup(&pool, &[&alice, &bob]).await;
    }
}
