//! Unified application error type.
//!
//! Handlers return [`AppResult`] and use `?` instead of hand-matching every
//! fallible call into an `HttpResponse`. `AppError` implements
//! [`actix_web::ResponseError`], so Actix renders it to the right status code
//! automatically, and server-side faults are logged in one place here rather
//! than at every call site.

use actix_web::{HttpResponse, http::StatusCode};
use tracing::error;

#[derive(Debug)]
pub enum AppError {
    /// A database / `sqlx` failure — 500, logged; the client sees a generic
    /// message so query internals never leak.
    Db(sqlx::Error),
    /// An unexpected internal fault — 500, logged. The string is log context,
    /// never sent to the client.
    Internal(String),
    /// The request carried no valid credentials — 401.
    Unauthorized,
    /// Authenticated, but not allowed to perform this action — 403.
    // Part of the complete taxonomy; constructed as more modules adopt AppError.
    #[allow(dead_code)]
    Forbidden,
    /// The addressed resource does not exist — 404; the label names the kind.
    NotFound(&'static str),
    /// The caller's input was rejected — 400; the message is returned as-is.
    // Part of the complete taxonomy; constructed as more modules adopt AppError.
    #[allow(dead_code)]
    BadRequest(String),
}

/// Handler return type. `Ok` is the success response; `Err` is rendered by
/// `AppError`'s [`actix_web::ResponseError`] impl.
pub type AppResult = Result<HttpResponse, AppError>;

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Db(e) => write!(f, "database error: {e}"),
            AppError::Internal(msg) => write!(f, "{msg}"),
            AppError::Unauthorized => write!(f, "unauthorized"),
            AppError::Forbidden => write!(f, "forbidden"),
            AppError::NotFound(kind) => write!(f, "{kind} not found"),
            AppError::BadRequest(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for AppError {}

impl actix_web::ResponseError for AppError {
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::Db(_) | AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
        }
    }

    fn error_response(&self) -> HttpResponse {
        // Log server-side faults once, here, instead of at every call site.
        match self {
            AppError::Db(e) => error!(target: "db", error = ?e, "request failed"),
            AppError::Internal(msg) => error!(target: "http", error = %msg, "request failed"),
            _ => {}
        }
        // 5xx bodies are generic; 4xx bodies carry the (caller-safe) reason.
        let message = match self {
            AppError::Db(_) | AppError::Internal(_) => "Internal server error".to_string(),
            other => other.to_string(),
        };
        HttpResponse::build(self.status_code())
            .json(serde_json::json!({ "message": message }))
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Db(e)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
