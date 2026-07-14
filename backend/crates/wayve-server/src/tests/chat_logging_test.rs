// The chat WebSocket handler must reject an unauthenticated connection before
// upgrading it, and log that rejection under target "ws" — the target the
// dev.log filters rely on. These tests capture emitted tracing events and assert
// both the 401 and the log line.
//
// The rejection happens before the pool or cache is touched, so a lazy pool that
// never connects and a `None` cache are enough; no database or Redis is needed.

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
        // The URL is irrelevant: connect_lazy opens no socket until the pool is
        // used, and the rejection path never uses it.
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

    #[actix_web::test]
    async fn unauthenticated_chat_ws_is_rejected_and_logged() {
        let (status, logs) = call_chat_ws("/ws/chat").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(
            has_ws_rejection(&logs),
            "expected a target=ws rejection log, got: {logs:?}"
        );
    }

    // A bogus `?token=` must be rejected too. It is #[serial] because decoding
    // reads the JWT config, which needs JWT_SECRET set in process env.
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
