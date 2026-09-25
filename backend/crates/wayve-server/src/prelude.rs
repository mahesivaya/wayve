//! Common imports for `wayve-server`. Prefer `use crate::prelude::*;` in new files.

pub use actix_web::{Error, HttpRequest, HttpResponse, Responder, get, post, web};

pub use actix::{Actor, ActorContext, AsyncContext};

pub use sqlx::{FromRow, PgPool, Row};

pub use serde::{Deserialize, Serialize};
pub use serde_json::Value;

pub use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

pub use reqwest::Client;

pub use futures::stream::{FuturesUnordered, StreamExt};

pub use once_cell::sync::Lazy;

pub use std::fs;

pub use crate::error::{AppError, AppResult};
pub use anyhow::Result;

pub const MAX_EMAIL_CONCURRENCY: usize = 20;
pub const BATCH_SIZE: usize = 50;

/// Caps how many drive/file uploads can be buffering in memory at once,
/// server-wide. A single upload is already bounded by the account's storage
/// quota (see `drive::handler::upload_file`), but nothing else stops many
/// concurrent uploads from each holding their own multi-MB buffer at the same
/// time — this bounds *total* memory pressure regardless of per-file size or
/// how many users upload simultaneously.
pub const MAX_CONCURRENT_UPLOADS: usize = 8;
