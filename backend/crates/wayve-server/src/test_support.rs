#![allow(dead_code)]

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

pub async fn test_pool() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL")
        .ok()
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| panic!("Set TEST_DATABASE_URL or DATABASE_URL to run tests"));

    PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .unwrap_or_else(|err| panic!("connect to test DB: {err}"))
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

pub fn jwt_for(user_id: i32, email: &str) -> String {
    unsafe {
        if std::env::var("JWT_SECRET").is_err() {
            std::env::set_var("JWT_SECRET", "test-jwt-secret");
        }
    }

    wayve_security::jwt::create_jwt(user_id, email.to_string())
}

/// Monotonic counter for synthetic user_ids used by WS tests that don't need
/// real DB users.
static SYNTHETIC_USER_ID: std::sync::atomic::AtomicI32 =
    std::sync::atomic::AtomicI32::new(900_000_000);

pub fn next_synthetic_user_id() -> i32 {
    SYNTHETIC_USER_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}
