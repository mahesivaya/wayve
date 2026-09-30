// One user, several live chat sockets (tabs or devices). Runs the real
// `/ws/chat` endpoint on a test server and connects real WebSocket clients, with
// no Redis, so delivery goes through the in-process session registry and
// presence uses its no-Redis fallback. Pins that every one of a user's sockets
// receives messages, that closing any one (including the older socket after a
// reconnect) leaves the rest working, that a user's own sends and reads reach
// their other sockets, and that presence goes offline only with the last one.
#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use crate::chat::handler::chat_ws;
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, web};
    use awc::ws;
    use futures_util::{SinkExt, Stream, StreamExt};
    use serde_json::Value;
    use sqlx::PgPool;
    use std::time::Duration;

    const E2E: &str = "WAYVE_CHAT_E2E_V1\n";

    struct User {
        id: i32,
        token: String,
    }

    async fn user(pool: &PgPool) -> User {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        User {
            id,
            token: jwt_for(id, &email),
        }
    }

    /// DMs are stored encrypted at rest, so the handler needs `AES_KEY`.
    fn ensure_aes_key() {
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
    }

    fn server(pool: &PgPool) -> actix_test::TestServer {
        let pool = pool.clone();
        actix_test::start(move || {
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .route("/ws/chat", web::get().to(chat_ws))
        })
    }

    macro_rules! connect {
        ($srv:expr, $user:expr) => {{
            let (_, conn) = awc::Client::new()
                .ws($srv.url(&format!("/ws/chat?token={}", $user.token)))
                .connect()
                .await
                .unwrap_or_else(|e| panic!("ws connect: {e}"));
            conn
        }};
    }

    async fn send<S>(conn: &mut S, frame: Value)
    where
        S: futures_util::Sink<ws::Message> + Unpin,
        S::Error: std::fmt::Debug,
    {
        conn.send(ws::Message::Text(frame.to_string().into()))
            .await
            .unwrap_or_else(|e| panic!("ws send: {e:?}"));
    }

    /// The first text frame matching `pred` within `wait`, skipping others.
    async fn wait_for<S, E>(
        conn: &mut S,
        wait: Duration,
        pred: impl Fn(&Value) -> bool,
    ) -> Option<Value>
    where
        S: Stream<Item = Result<ws::Frame, E>> + Unpin,
    {
        let deadline = actix_web::rt::time::Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(actix_web::rt::time::Instant::now());
            match actix_web::rt::time::timeout(left, conn.next()).await {
                Ok(Some(Ok(ws::Frame::Text(bytes)))) => {
                    if let Ok(v) = serde_json::from_slice::<Value>(&bytes)
                        && pred(&v)
                    {
                        return Some(v);
                    }
                }
                Ok(Some(Ok(_))) => continue,
                _ => return None,
            }
        }
    }

    const ARRIVES: Duration = Duration::from_secs(5);
    const QUIET: Duration = Duration::from_millis(800);

    fn dm(from: &User, to: &User, client_id: &str) -> Value {
        serde_json::json!({
            "sender_id": from.id,
            "receiver_id": to.id,
            "content": format!("{E2E}payload"),
            "client_id": client_id,
        })
    }

    fn is_dm(v: &Value, client_id: &str) -> bool {
        v["client_id"] == client_id && v["message_id"].is_number()
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn every_tab_receives_and_closing_any_tab_leaves_the_rest() {
        ensure_aes_key();
        let pool = test_pool().await;
        let srv = server(&pool);
        let (a, b) = (user(&pool).await, user(&pool).await);

        let mut a1 = connect!(srv, a);
        let mut a2 = connect!(srv, a);
        let mut b1 = connect!(srv, b);

        send(&mut b1, dm(&b, &a, "to-a-1")).await;
        assert!(
            wait_for(&mut a1, ARRIVES, |v| is_dm(v, "to-a-1"))
                .await
                .is_some(),
            "older tab"
        );
        assert!(
            wait_for(&mut a2, ARRIVES, |v| is_dm(v, "to-a-1"))
                .await
                .is_some(),
            "newer tab"
        );

        // A user's own send reaches their other tab, carrying the client_id the
        // sending tab reconciles its optimistic copy with.
        send(&mut a1, dm(&a, &b, "from-a")).await;
        assert!(
            wait_for(&mut b1, ARRIVES, |v| is_dm(v, "from-a"))
                .await
                .is_some()
        );
        assert!(
            wait_for(&mut a2, ARRIVES, |v| is_dm(v, "from-a"))
                .await
                .is_some(),
            "the sender's other tab sees their message"
        );

        // Closing the newer tab no longer deafens the older one.
        let _ = a2.close().await;
        actix_web::rt::time::sleep(Duration::from_millis(200)).await;
        send(&mut b1, dm(&b, &a, "to-a-2")).await;
        assert!(
            wait_for(&mut a1, ARRIVES, |v| is_dm(v, "to-a-2"))
                .await
                .is_some()
        );

        // Reconnect order: a new socket registers, then the old one closes. The
        // old one's cleanup must not take the new one's delivery.
        let mut a3 = connect!(srv, a);
        let _ = a1.close().await;
        actix_web::rt::time::sleep(Duration::from_millis(200)).await;
        send(&mut b1, dm(&b, &a, "to-a-3")).await;
        assert!(
            wait_for(&mut a3, ARRIVES, |v| is_dm(v, "to-a-3"))
                .await
                .is_some()
        );
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn reading_in_one_tab_clears_it_in_the_others() {
        ensure_aes_key();
        let pool = test_pool().await;
        let srv = server(&pool);
        let (a, b) = (user(&pool).await, user(&pool).await);

        let mut a1 = connect!(srv, a);
        let mut a2 = connect!(srv, a);
        let mut b1 = connect!(srv, b);

        send(&mut b1, dm(&b, &a, "unread")).await;
        assert!(
            wait_for(&mut a2, ARRIVES, |v| is_dm(v, "unread"))
                .await
                .is_some()
        );

        send(
            &mut a1,
            serde_json::json!({
                "sender_id": a.id, "receiver_id": b.id, "content": "", "status": "read",
            }),
        )
        .await;
        let read = wait_for(&mut a2, ARRIVES, |v| v["type"] == "conversation_read").await;
        assert_eq!(
            read.map(|v| v["user_id"].clone()),
            Some(serde_json::json!(b.id))
        );
        assert!(
            wait_for(&mut b1, ARRIVES, |v| v["type"] == "status_update"
                && v["status"] == "read")
            .await
            .is_some(),
            "the sender still gets the read tick"
        );
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn presence_goes_offline_only_with_the_last_tab() {
        ensure_aes_key();
        let pool = test_pool().await;
        let srv = server(&pool);
        let (a, b) = (user(&pool).await, user(&pool).await);
        // Contacts via a shared channel, so presence is broadcast between them.
        let channel_id: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by, visibility) VALUES ('p', $1, 'private') RETURNING id",
        )
        .bind(a.id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("channel: {e}"));
        sqlx::query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)")
            .bind(channel_id)
            .bind(a.id)
            .bind(b.id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("members: {e}"));

        let mut b1 = connect!(srv, b);
        let a1 = connect!(srv, a);
        let mut a2 = connect!(srv, a);
        let offline =
            |v: &Value| v["type"] == "presence" && v["user_id"] == a.id && v["online"] == false;

        let _ = a2.close().await;
        assert!(
            wait_for(&mut b1, QUIET, offline).await.is_none(),
            "a tab closing while another is open must not flip the user offline"
        );

        drop(a1);
        assert!(
            wait_for(&mut b1, ARRIVES, offline).await.is_some(),
            "the last tab closing does"
        );
    }
}
