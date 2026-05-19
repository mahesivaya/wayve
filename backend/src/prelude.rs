// 🌐 Actix Web
pub use actix_web::{Error, HttpRequest, HttpResponse, Responder, get, post, web};

// 🔌 WebSocket (Actix actors)
pub use actix::{Actor, ActorContext, AsyncContext};

// 🗄️ Database (SQLx)
pub use sqlx::{FromRow, PgPool, Row};

// 📦 Serialization
pub use serde::{Deserialize, Serialize};
pub use serde_json::Value;

// ⏱️ Date & Time
pub use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

// 🌍 HTTP client (Gmail API etc.)
pub use reqwest::Client;

// ⚡ Async utilities
pub use futures::stream::{FuturesUnordered, StreamExt};

// 🧠 Global state helpers
pub use once_cell::sync::Lazy;

// 📁 File handling
pub use std::fs;

// ❗ Error handling
pub use crate::error::{AppError, AppResult};
pub use anyhow::Result;

// 🚀 Constants
pub const MAX_EMAIL_CONCURRENCY: usize = 20;
pub const BATCH_SIZE: usize = 50;
