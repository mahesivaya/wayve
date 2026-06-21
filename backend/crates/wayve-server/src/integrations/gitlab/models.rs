use crate::prelude::*;

/// A decrypted per-user GitLab connection, ready for authenticated calls.
/// Never serialized — it carries the plaintext access token.
pub struct GitlabConnection {
    pub base_url: String,
    pub access_token: String,
    pub enabled: bool,
}

/// Connection state returned to the frontend. Carries no secret.
#[derive(Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub base_url: Option<String>,
    pub enabled: bool,
}

#[derive(Deserialize)]
pub struct ConnectInput {
    /// Instance base, e.g. `https://gitlab.com` or a self-hosted host. Defaults
    /// to gitlab.com when omitted/blank.
    #[serde(default)]
    pub base_url: Option<String>,
    /// GitLab personal access token (validated with `GET /user`).
    pub access_token: String,
}

#[derive(Deserialize)]
pub struct ImportInput {
    /// `opened` (default), `closed`, or `all`.
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub max_results: Option<u32>,
}

// ---- GitLab REST response shapes (only the fields we read) ----

#[derive(Deserialize)]
pub struct GitlabIssue {
    pub iid: i32,
    pub project_id: i32,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub web_url: String,
}
