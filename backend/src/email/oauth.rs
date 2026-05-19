use crate::prelude::*;
use anyhow::{Context, anyhow};
use tracing::{instrument, warn};

pub fn try_load_google_secrets() -> Result<serde_json::Value> {
    // Preferred: credentials from the centralized secrets file (.env.secrets),
    // surfaced as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. The shape mirrors a
    // Google `client_secret.json` so every consumer stays unchanged.
    let google = crate::config::google_oauth();
    if let (Some(client_id), Some(client_secret)) = (google.client_id, google.client_secret) {
        return Ok(serde_json::json!({
            "web": { "client_id": client_id, "client_secret": client_secret }
        }));
    }

    // Fallback: legacy client_secret.json file. GOOGLE_CLIENT_SECRET_PATH lets
    // tests (and any setup still using the file) point at a custom location.
    let path = google.client_secret_path;
    let data = fs::read_to_string(&path).with_context(|| {
        format!("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set and could not read {path}")
    })?;

    serde_json::from_str(&data).with_context(|| format!("Failed to parse {path}"))
}

pub fn load_google_secrets() -> serde_json::Value {
    try_load_google_secrets().unwrap_or_else(|e| panic!("{e}"))
}

#[instrument(target = "gmail", skip_all)]
pub async fn refresh_access_token(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<String> {
    let res: Value = HTTP_CLIENT
        .post(crate::external::google_token_url())
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .context("Google token refresh request failed")?
        .json()
        .await
        .context("Google token refresh response parse failed")?;

    if let Some(err) = res.get("error") {
        warn!(target: "gmail", error = %err, "google token refresh returned error");
        return Err(anyhow!("Token refresh failed: {err}"));
    }

    Ok(res["access_token"].as_str().unwrap_or("").to_string())
}

pub static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .pool_max_idle_per_host(20)
        .build()
        .unwrap()
});
