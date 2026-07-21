//! Per-organization AI provider resolution. The provider is chosen by the
//! enterprise owner and stored (encrypted) in `org_ai_configs`. Resolution is keyed
//! on the caller's organization with no per-user override, so every member uses the
//! owner's choice. Callers outside a configured org fall back to the platform
//! default (Gemini from env).

use crate::prelude::*;
use wayve_security::encryption::decrypt;

/// Which upstream the assistant talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiProvider {
    Gemini,
    Anthropic,
    /// Any OpenAI-compatible Chat Completions endpoint, addressed by `base_url`.
    OpenAiCompatible,
}

impl AiProvider {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "gemini" => Some(Self::Gemini),
            "anthropic" => Some(Self::Anthropic),
            "openai_compatible" => Some(Self::OpenAiCompatible),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::Anthropic => "anthropic",
            Self::OpenAiCompatible => "openai_compatible",
        }
    }

    /// The model used when the owner didn't pin one.
    pub fn default_model(self) -> &'static str {
        match self {
            Self::Gemini => "gemini-2.0-flash",
            Self::Anthropic => "claude-opus-4-8",
            Self::OpenAiCompatible => "gpt-4o-mini",
        }
    }

    /// Whether this provider requires a stored API key. Only Gemini may run on
    /// the platform's env key, so the others must carry their own.
    pub fn requires_key(self) -> bool {
        !matches!(self, Self::Gemini)
    }
}

/// Which categories of the user's own Wayve data the assistant's native tools may
/// touch. Defaults to fully open, which is what org, personal, and env-fallback
/// callers get.
#[derive(Debug, Clone, Copy)]
pub struct DataAccess {
    pub email: bool,
    pub calendar: bool,
}

impl Default for DataAccess {
    fn default() -> Self {
        Self {
            email: true,
            calendar: true,
        }
    }
}

/// Carries the plaintext API key, so it must never be serialized.
#[derive(Clone)]
pub struct ResolvedAi {
    pub provider: AiProvider,
    pub api_key: String,
    pub model: String,
    /// Custom endpoint root for `OpenAiCompatible` (required there). `None` →
    /// the provider's vendor default base.
    pub base_url: Option<String>,
    /// When true a provider error is surfaced to the user instead of silently
    /// falling back. Always true for an org-configured provider.
    pub fail_closed: bool,
    pub data_access: DataAccess,
}

/// Resolution order: the caller's org's enabled `org_ai_configs` row; else
/// `platform_ai_config`, but only for platform members; else the platform default
/// (Gemini from `GEMINI_API_KEY`). `Ok(None)` means none is configured anywhere.
pub async fn resolve_ai_for_user(
    pool: &PgPool,
    user_id: i32,
) -> Result<Option<ResolvedAi>, AppError> {
    // Platform and personal users have organization_id NULL, so this never
    // matches for them.
    let row = sqlx::query(
        "SELECT c.provider, c.base_url, c.model, c.api_key_iv, c.api_key_encrypted, c.fail_closed
           FROM users u
           JOIN org_ai_configs c ON c.organization_id = u.organization_id
          WHERE u.id = $1 AND c.enabled",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    if let Some(row) = row {
        return Ok(Some(resolved_from_row(&row)?));
    }

    // Only platform members may read the platform owner's choice.
    let is_platform_member: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform_members WHERE user_id = $1)")
            .bind(user_id)
            .fetch_one(pool)
            .await?;
    if is_platform_member {
        let prow = sqlx::query(
            "SELECT provider, base_url, model, api_key_iv, api_key_encrypted, fail_closed,
                    ai_allow_email, ai_allow_calendar
               FROM platform_ai_config WHERE id = 1 AND enabled",
        )
        .fetch_optional(pool)
        .await?;
        if let Some(row) = prow {
            return Ok(Some(resolved_from_row(&row)?));
        }
    }

    Ok(env_default_ai())
}

/// The platform's env-configured default provider, used when neither an org nor a
/// platform config applies. Prefers Anthropic (Claude) when `ANTHROPIC_API_KEY`
/// is set — so a prod deployment auto-uses Claude with no in-app configuration —
/// and otherwise falls back to Gemini (`GEMINI_API_KEY`). `None` when neither key
/// is present.
fn env_default_ai() -> Option<ResolvedAi> {
    if let Some(api_key) = crate::config::anthropic_api_key() {
        return Some(ResolvedAi {
            provider: AiProvider::Anthropic,
            api_key,
            model: crate::config::anthropic_model(),
            base_url: None,
            fail_closed: false,
            data_access: DataAccess::default(),
        });
    }
    crate::config::gemini_api_key().map(|api_key| ResolvedAi {
        provider: AiProvider::Gemini,
        api_key,
        model: crate::config::gemini_model(),
        base_url: None,
        fail_closed: false,
        data_access: DataAccess::default(),
    })
}

/// Falls back to the platform Gemini env key when the row stored no key.
fn resolved_from_row(row: &sqlx::postgres::PgRow) -> Result<ResolvedAi, AppError> {
    let provider =
        AiProvider::parse(&row.get::<String, _>("provider")).unwrap_or(AiProvider::Gemini);
    let base_url: Option<String> = row.try_get("base_url").ok().flatten();
    let model: Option<String> = row.try_get("model").ok().flatten();
    let fail_closed: bool = row.try_get("fail_closed").unwrap_or(true);
    // Only the platform row projects these columns, so a missing column falls back
    // to fully open: the org path is never gated.
    let data_access = DataAccess {
        email: row.try_get("ai_allow_email").unwrap_or(true),
        calendar: row.try_get("ai_allow_calendar").unwrap_or(true),
    };

    let iv: Option<String> = row.try_get("api_key_iv").ok().flatten();
    let enc: Option<String> = row.try_get("api_key_encrypted").ok().flatten();
    let api_key = match (iv, enc) {
        (Some(iv), Some(enc)) => decrypt(&iv, &enc)
            .map_err(|e| AppError::Internal(format!("Failed to read AI credentials: {e}")))?,
        // Only Gemini may run without a stored key, on the platform env key.
        _ => match (provider, crate::config::gemini_api_key()) {
            (AiProvider::Gemini, Some(key)) => key,
            _ => {
                return Err(AppError::Internal(
                    "AI provider has no API key configured".into(),
                ));
            }
        },
    };

    Ok(ResolvedAi {
        provider,
        api_key,
        model: model.unwrap_or_else(|| provider.default_model().to_string()),
        base_url,
        fail_closed,
        data_access,
    })
}
