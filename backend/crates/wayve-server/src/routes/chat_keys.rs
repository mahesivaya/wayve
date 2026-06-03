// Backfill chat E2E keypairs for members that don't have one.
//
// Chat is end-to-end encrypted: to message someone you encrypt to their RSA
// public key, and they decrypt with a private key restored on login. Accounts
// created by SQL seed (or any import) never ran the client-side key setup, so
// their `users.public_key` is NULL and chatting with them errors with
// "<email> has no chat encryption key".
//
// This platform-owner-only endpoint provisions a keypair for every such member
// whose password matches the one supplied: it server-generates the keypair
// (same path as org-member provisioning — `provision_org_owner_keypair`, which
// wraps the private key under PBKDF2(password) and zeroizes the plaintext),
// stores the public key, and writes a `member_login_wrapped_keys` row so the
// member's private key is restored automatically on their next browser login
// (auth.rs returns the wrap; Login.tsx unwraps it). The directory scoping is
// unchanged — platform members see platform members, org members see their own
// org — so this only fills in the missing keys.
//
// Password match is enforced per user (bcrypt verify), so an account using a
// different password is skipped rather than given a wrap it can't open.

use crate::prelude::*;
use tracing::{info, instrument, warn};
use wayve_security::encryption::provision_org_owner_keypair;
use wayve_security::password::verify_password;
use wayve_security::rbac::{self, Permission, Role, Scope};

// Default seed password (scripts/seed_rbac_users.sh uses "Mahesh"). The caller
// can override per request for a different shared password.
const DEFAULT_SEED_PASSWORD: &str = "Mahesh";

#[derive(Deserialize)]
pub struct ProvisionInput {
    pub password: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Candidate {
    id: i32,
    email: String,
    password: Option<String>,
}

#[post("/platform/provision-chat-keys")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn provision_chat_keys(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ProvisionInput>,
) -> AppResult {
    // Platform owner only — this mints keypairs for other users.
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersManage).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Platform || ctx.role != Role::Owner {
        return Ok(HttpResponse::Forbidden()
            .json(serde_json::json!({ "message": "Platform owner only" })));
    }

    let password = body
        .password
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SEED_PASSWORD)
        .to_string();

    // Every member missing a usable public key, that still has a local password
    // to verify against (OAuth-only accounts have none and are skipped).
    let candidates = sqlx::query_as::<_, Candidate>(
        r#"
        SELECT id, email, password
        FROM users
        WHERE (public_key IS NULL OR public_key = '')
          AND password IS NOT NULL
        ORDER BY id
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let total = candidates.len();
    let mut provisioned: Vec<String> = Vec::new();
    let mut skipped: u32 = 0;

    for c in candidates {
        let Some(hashed) = c.password.as_deref() else {
            skipped += 1;
            continue;
        };
        // Only provision accounts that actually use the supplied password,
        // so we never write a wrap the member can't unwrap.
        let matches = verify_password(&password, hashed).await.unwrap_or(false);
        if !matches {
            skipped += 1;
            continue;
        }

        // RSA-2048 keygen is CPU-heavy and holds the plaintext key — keep it
        // off the async executor on a blocking thread.
        let pw = password.clone();
        let provisioned_keys =
            match tokio::task::spawn_blocking(move || provision_org_owner_keypair(&pw)).await {
                Ok(Ok(keys)) => keys,
                Ok(Err(err)) => {
                    warn!(target: "auth", user_id = c.id, error = ?err, "keypair provision failed");
                    skipped += 1;
                    continue;
                }
                Err(err) => {
                    warn!(target: "auth", user_id = c.id, error = ?err, "provision task join failed");
                    skipped += 1;
                    continue;
                }
            };

        sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
            .bind(&provisioned_keys.public_key_json)
            .bind(c.id)
            .execute(pool.get_ref())
            .await?;

        let wrap = &provisioned_keys.login_wrap;
        sqlx::query(
            r#"
            INSERT INTO member_login_wrapped_keys (user_id, iv, ct, salt, iterations)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id) DO UPDATE
            SET iv = EXCLUDED.iv,
                ct = EXCLUDED.ct,
                salt = EXCLUDED.salt,
                iterations = EXCLUDED.iterations,
                updated_at = NOW()
            "#,
        )
        .bind(c.id)
        .bind(&wrap.iv_b64)
        .bind(&wrap.ct_b64)
        .bind(&wrap.salt_b64)
        .bind(wrap.iterations as i32)
        .execute(pool.get_ref())
        .await?;

        provisioned.push(c.email);
    }

    info!(
        target: "auth",
        actor = ctx.user_id,
        provisioned = provisioned.len(),
        skipped,
        "backfilled chat keypairs"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "total_missing": total,
        "provisioned": provisioned.len(),
        "provisioned_emails": provisioned,
        "skipped": skipped,
    })))
}