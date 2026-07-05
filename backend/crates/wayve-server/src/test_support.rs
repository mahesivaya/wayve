#![allow(dead_code)]

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

pub async fn test_pool() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL")
        .ok()
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| panic!("Set TEST_DATABASE_URL or DATABASE_URL to run tests"));

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .unwrap_or_else(|err| panic!("connect to test DB: {err}"));

    // Mirror what main.rs does at boot. init.sql is the canonical schema
    // for the tables compose loads on first-boot, but tables added later
    // (scim_tokens, webhook_endpoints, ...) live in ensure_email_schema
    // and are idempotent. CI ran into "relation does not exist" errors
    // because the fresh CI Postgres had only init.sql applied; test_pool
    // now closes that gap so tests are self-sufficient regardless of
    // whether the DB started fresh or was reused.
    crate::startup::ensure_email_schema(&pool).await;

    pool
}

pub fn random_email() -> String {
    format!("test-{}@example.com", Uuid::new_v4())
}

/// Insert a local-auth user with bcrypt-hashed password and return the user id.
pub async fn insert_local_user(pool: &PgPool, email: &str, password: &str) -> i32 {
    let hashed = bcrypt::hash(password, bcrypt::DEFAULT_COST)
        .unwrap_or_else(|err| panic!("hash password failed: {err}"));

    let row = sqlx::query(
        "INSERT INTO users (email, password)
         VALUES ($1, $2)
         RETURNING id",
    )
    .bind(email)
    .bind(&hashed)
    .fetch_one(pool)
    .await
    .unwrap_or_else(|err| panic!("insert user failed: {err}"));

    sqlx::Row::get(&row, "id")
}

/// Insert a Google-auth user (NULL password) and return the user id.
pub async fn insert_google_user(pool: &PgPool, email: &str) -> i32 {
    let row = sqlx::query(
        "INSERT INTO users
         (email, password, auth_provider)
         VALUES ($1, NULL, 'google')
         RETURNING id",
    )
    .bind(email)
    .fetch_one(pool)
    .await
    .unwrap_or_else(|err| panic!("insert google user failed: {err}"));

    sqlx::Row::get(&row, "id")
}

pub async fn delete_user(pool: &PgPool, user_id: i32) {
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await;
}

/// Mint a test token in the given session mode. Most tests exercise a user's
/// full DB role, so `jwt_for` defaults to `Admin` (no downscope) — the mode
/// feature is orthogonal to the RBAC-by-role behavior they assert. Tests that
/// specifically exercise normal-mode downscoping pass `SessionMode::Normal`.
pub fn jwt_for_mode(user_id: i32, email: &str, mode: wayve_security::jwt::SessionMode) -> String {
    unsafe {
        if std::env::var("JWT_SECRET").is_err() {
            std::env::set_var("JWT_SECRET", "test-jwt-secret");
        }
    }

    wayve_security::jwt::create_jwt_with_mode(
        user_id,
        email.to_string(),
        "personal".to_string(),
        None,
        mode,
    )
}

pub fn jwt_for(user_id: i32, email: &str) -> String {
    jwt_for_mode(user_id, email, wayve_security::jwt::SessionMode::Admin)
}

/// Monotonic counter for synthetic user_ids used by WS tests that don't need
/// real DB users.
static SYNTHETIC_USER_ID: std::sync::atomic::AtomicI32 =
    std::sync::atomic::AtomicI32::new(900_000_000);

pub fn next_synthetic_user_id() -> i32 {
    SYNTHETIC_USER_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}
