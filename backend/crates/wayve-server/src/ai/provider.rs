//! Per-organization AI provider resolution.
//!
//! The AI assistant runs on a provider chosen by the enterprise **owner** and
//! stored (encrypted) in `org_ai_configs`. Every member of that org uses the
//! owner's choice — resolution is keyed on the caller's organization, with no
//! per-user override. When the org has no config (or the caller isn't in an org),
//! we fall back to the platform default (Gemini from env), so personal/business
//! users and un-configured orgs behave exactly as before.

use crate::prelude::*;
use wayve_security::encryption::decrypt;

/// Which upstream the assistant talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiProvider {
    Gemini,
    Anthropic,
    /// Any OpenAI-compatible Chat Completions endpoint (OpenAI, Azure OpenAI, an
    /// AWS Bedrock gateway, an internal LiteLLM proxy, …) addressed by `base_url`.
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

/// Which categories of the user's own Wayve data the assistant's native tools
/// may touch. Only categories that have native tools today are represented
/// (email, calendar); the toggle is configured by the platform owner and stored
/// on `platform_ai_config`. Defaults to fully-open so org/personal callers and
/// the env fallback behave exactly as before.
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

/// A fully-resolved provider config, ready to call. Carries the plaintext key —
/// never serialized.
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
    /// Which data categories the native tools may access. Populated from the
    /// platform config; open for org/personal/env-fallback resolution.
    pub data_access: DataAccess,
}

/// Resolve the AI provider for `user_id`, in order:
/// 1. the caller's org has an enabled `org_ai_configs` row → use it (binds every
///    member of the org to the owner's choice);
/// 2. the caller is a **platform team member** and the platform owner configured
///    `platform_ai_config` → use it (scoped strictly to platform members — this
///    never touches org/personal resolution above);
/// 3. otherwise the platform default (Gemini from `GEMINI_API_KEY`).
///
/// `Ok(None)` means no provider is configured anywhere — the caller should return
/// "AI not configured".
pub async fn resolve_ai_for_user(
    pool: &PgPool,
    user_id: i32,
) -> Result<Option<ResolvedAi>, AppError> {
    // 1. Org config. One round-trip joining the caller to their org's config;
    //    members and the owner resolve identically. Platform/personal users have
    //    organization_id NULL, so this never matches for them.
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

    // 2. Platform-team config. Only platform members read the platform owner's
    //    choice; orgs/personal users never reach here (their resolution ended
    //    above or falls through to the env default below).
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

    // 3. Platform default — Gemini from env; `None` when unset.
    Ok(crate::config::gemini_api_key().map(|api_key| ResolvedAi {
        provider: AiProvider::Gemini,
        api_key,
        model: crate::config::gemini_model(),
        base_url: None,
        fail_closed: false,
        data_access: DataAccess::default(),
    }))
}

/// Build a [`ResolvedAi`] from a config row (org or platform — both project the
/// same columns). Decrypts the stored key, or falls back to the platform Gemini
/// env key when the row stored none (only valid for Gemini).
fn resolved_from_row(row: &sqlx::postgres::PgRow) -> Result<ResolvedAi, AppError> {
    let provider =
        AiProvider::parse(&row.get::<String, _>("provider")).unwrap_or(AiProvider::Gemini);
    let base_url: Option<String> = row.try_get("base_url").ok().flatten();
    let model: Option<String> = row.try_get("model").ok().flatten();
    let fail_closed: bool = row.try_get("fail_closed").unwrap_or(true);
    // Only the platform row projects these columns; org rows don't, so a missing
    // column falls back to fully-open (the org path is never gated).
    let data_access = DataAccess {
        email: row.try_get("ai_allow_email").unwrap_or(true),
        calendar: row.try_get("ai_allow_calendar").unwrap_or(true),
    };

    let iv: Option<String> = row.try_get("api_key_iv").ok().flatten();
    let enc: Option<String> = row.try_get("api_key_encrypted").ok().flatten();
    let api_key = match (iv, enc) {
        (Some(iv), Some(enc)) => decrypt(&iv, &enc)
            .map_err(|e| AppError::Internal(format!("Failed to read AI credentials: {e}")))?,
        // No stored key — only valid for Gemini, which may use the platform key.
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
