// Chat app logging tests.
//
// The chat WebSocket handler logs an auth rejection under target "ws" before
// it ever upgrades the connection. These tests install a thread-local tracing
// subscriber that captures emitted events, drive the real `chat_ws` handler
// through an actix test app, and assert BOTH the behavior (401) and that the
// expected `target = "ws"` warning was logged.
//
// No DB/Redis needed: the rejection happens before the pool/cache are touched,
// so a lazy (never-connected) pool and a `None` cache are sufficient.

#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use crate::chat::handler::chat_ws;
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use sqlx::PgPool;
    use std::sync::{Arc, Mutex};
    use tracing::field::{Field, Visit};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::Layer;
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::registry::LookupSpan;

    // ---- captured-log plumbing ------------------------------------------------

    #[derive(Clone, Default)]
    struct CapturedLogs {
        lines: Arc<Mutex<Vec<String>>>,
    }

    impl CapturedLogs {
        fn snapshot(&self) -> Vec<String> {
            self.lines.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    struct FieldVisitor {
        msg: String,
    }

    impl Visit for FieldVisitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            if field.name() == "message" {
                self.msg.push_str(&format!("{value:?} "));
            } else {
                self.msg.push_str(&format!("{}={value:?} ", field.name()));
            }
        }
    }

    struct CaptureLayer {
        captured: CapturedLogs,
    }

    impl<S> Layer<S> for CaptureLayer
    where
        S: Subscriber + for<'a> LookupSpan<'a>,
    {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let meta = event.metadata();
            let mut v = FieldVisitor { msg: String::new() };
            event.record(&mut v);
            let line = format!("{} target={} {}", meta.level(), meta.target(), v.msg);
            self.captured
                .lines
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(line);
        }
    }

    fn lazy_pool() -> PgPool {
        // connect_lazy never opens a socket until the pool is used; the auth
        // rejection path never touches it, so the URL is irrelevant.
        PgPool::connect_lazy("postgres://unused:unused@127.0.0.1:5432/unused")
            .unwrap_or_else(|e| panic!("connect_lazy: {e}"))
    }

    async fn call_chat_ws(uri: &str) -> (StatusCode, Vec<String>) {
        let captured = CapturedLogs::default();
        let subscriber = tracing_subscriber::registry().with(CaptureLayer {
            captured: captured.clone(),
        });
        let _guard = tracing::subscriber::set_default(subscriber);

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(lazy_pool()))
                .app_data(web::Data::new(None::<Cache>))
                .route("/ws/chat", web::get().to(chat_ws)),
        )
        .await;

        let req = actix_test::TestRequest::get().uri(uri).to_request();
        let resp = actix_test::call_service(&app, req).await;
        (resp.status(), captured.snapshot())
    }

    fn has_ws_rejection(lines: &[String]) -> bool {
        lines
            .iter()
            .any(|l| l.contains("target=ws") && l.to_lowercase().contains("reject"))
    }

    fn ensure_jwt_secret() {
        unsafe {
            if std::env::var("JWT_SECRET").is_err() {
                std::env::set_var("JWT_SECRET", "test-jwt-secret-chat-logging");
            }
        }
    }

    // ---- tests ----------------------------------------------------------------

    // No credentials at all → 401 and a target="ws" rejection warning.
    #[actix_web::test]
    async fn unauthenticated_chat_ws_is_rejected_and_logged() {
        let (status, logs) = call_chat_ws("/ws/chat").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(
            has_ws_rejection(&logs),
            "expected a target=ws rejection log, got: {logs:?}"
        );
    }

    // A bogus ?token= (fails JWT decode) is also rejected and logged. Decoding
    // touches the JWT config, which refuses to run without JWT_SECRET.
    #[actix_web::test]
    #[serial_test::serial]
    async fn invalid_token_chat_ws_is_rejected_and_logged() {
        ensure_jwt_secret();
        let (status, logs) = call_chat_ws("/ws/chat?token=not-a-real-jwt").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(
            has_ws_rejection(&logs),
            "expected a target=ws rejection log, got: {logs:?}"
        );
    }
}
