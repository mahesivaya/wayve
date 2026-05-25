use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use sqlx::{PgPool, Row};
use tracing::instrument;

#[derive(Debug)]
pub struct OAuthState {
    pub user_id: Option<i32>,
    pub flow: String,
}

pub fn random_oauth_state() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[instrument(target = "auth", skip(pool), fields(user_id, flow))]
pub async fn create_oauth_state(user_id: Option<i32>, flow: &str, pool: &PgPool) -> Result<String> {
    let state = random_oauth_state();
    store_state(&state, user_id, flow, pool).await?;
    Ok(state)
}

#[instrument(target = "auth", skip(state, pool), fields(user_id, flow))]
pub async fn store_state(
    state: &str,
    user_id: Option<i32>,
    flow: &str,
    pool: &PgPool,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO oauth_states (state, user_id, flow, expires_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
        "#,
    )
    .bind(state)
    .bind(user_id)
    .bind(flow)
    .execute(pool)
    .await?;

    Ok(())
}

#[instrument(target = "auth", skip(state, pool))]
pub async fn consume_state(state: &str, pool: &PgPool) -> Result<Option<OAuthState>> {
    let row = sqlx::query(
        r#"
        DELETE FROM oauth_states
        WHERE state = $1
          AND expires_at > NOW()
        RETURNING user_id, flow
        "#,
    )
    .bind(state)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| OAuthState {
        user_id: row.get("user_id"),
        flow: row.get("flow"),
    }))
}
