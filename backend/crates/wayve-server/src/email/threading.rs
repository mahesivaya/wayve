//! Conversation threading for synced mail: which emails are one conversation.
//!
//! Each email is placed in an `email_threads` row (`emails.thread_id`) as it is
//! synced, from the reply information it carries, in this order (a JWZ-style
//! scheme, per account):
//!
//! 1. The provider's own conversation id (Gmail `threadId`, Outlook
//!    `conversationId`): exact, so it wins.
//! 2. `In-Reply-To` / `References`: the conversation of any earlier message it
//!    replies to, plus that of any later message that replies to *it* (replies
//!    can arrive before their parent), merging the two if they differ.
//! 3. A reply ("Re:"/"Fwd:") with no link found: the most recent conversation
//!    with the same subject and the same correspondent within 30 days. Never
//!    applied to a non-reply, so two unrelated "Invoice" emails stay apart.
//! 4. Otherwise a new conversation.
//!
//! Only keyed hashes of message ids and subjects are stored for matching
//! (`compute_thread_key_hash`, useless without `AES_KEY`); the raw Message-ID
//! and References, which sending a threaded reply needs, are stored encrypted.
//! Everything here is best-effort: a threading failure is logged and never fails
//! the sync that delivered the email.

use crate::prelude::*;
use chrono::NaiveDateTime;
use tracing::warn;
use wayve_security::encryption::{compute_address_hash, compute_thread_key_hash, encrypt};

/// Advisory-lock class for "threading this account", so two syncs of the same
/// mailbox can't each create a conversation for the same thread at once.
const THREAD_LOCK_CLASS: i32 = 0x7468; // "th"

/// How far back the subject fallback (step 3) looks for a conversation.
const SUBJECT_FALLBACK_DAYS: i64 = 30;

/// The reply information one email carries. Message ids are stored without
/// their angle brackets, in their original case.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThreadHeaders {
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub provider_thread_id: Option<String>,
}

impl ThreadHeaders {
    /// Build from raw header values as they appear on the wire.
    pub fn from_raw(
        message_id: Option<&str>,
        in_reply_to: Option<&str>,
        references: Option<&str>,
        provider_thread_id: Option<&str>,
    ) -> Self {
        Self {
            message_id: message_id.and_then(|v| parse_message_ids(v).into_iter().next()),
            // A broken client can put several ids here; the last is the parent.
            in_reply_to: in_reply_to.and_then(|v| parse_message_ids(v).into_iter().last()),
            references: references.map(parse_message_ids).unwrap_or_default(),
            provider_thread_id: provider_thread_id
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string),
        }
    }

    fn is_empty(&self) -> bool {
        self.message_id.is_none()
            && self.in_reply_to.is_none()
            && self.references.is_empty()
            && self.provider_thread_id.is_none()
    }
}

/// Every message id in a header value, without angle brackets. Ids are normally
/// `<...>`; a value with no brackets at all (some broken clients) is split on
/// whitespace instead.
pub fn parse_message_ids(raw: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = raw;
    while let Some(start) = rest.find('<') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('>') else { break };
        let id = after[..end].trim();
        if !id.is_empty() {
            ids.push(id.to_string());
        }
        rest = &after[end + 1..];
    }
    if ids.is_empty() && !raw.contains('<') {
        ids = raw
            .split_whitespace()
            .map(|t| t.trim_matches(|c| c == ',' || c == ';'))
            .filter(|t| t.contains('@'))
            .map(str::to_string)
            .collect();
    }
    ids
}

/// The subject without reply/forward prefixes, lowercased with whitespace
/// collapsed, plus whether any such prefix was present (the email is a reply).
pub fn normalize_subject(subject: &str) -> (String, bool) {
    // English plus common localized forms (German AW/WG, Nordic SV, Dutch Antw).
    const PREFIXES: [&str; 8] = ["re", "fwd", "fw", "aw", "wg", "sv", "antw", "tr"];
    let mut s = subject.trim();
    let mut is_reply = false;
    loop {
        let lower = s.to_ascii_lowercase();
        let Some(prefix) = PREFIXES.iter().find(|p| lower.starts_with(**p)) else {
            break;
        };
        let mut tail = &s[prefix.len()..];
        // Optional counter: "Re[2]:" or "Re(2):".
        if let Some(stripped) = tail.strip_prefix('[').or_else(|| tail.strip_prefix('(')) {
            let digits = stripped.trim_start_matches(|c: char| c.is_ascii_digit());
            if digits.len() < stripped.len() {
                tail = digits.trim_start_matches([']', ')']);
            }
        }
        let tail = tail.trim_start();
        let Some(after) = tail.strip_prefix(':') else {
            break;
        };
        s = after.trim_start();
        is_reply = true;
    }
    let normalized = s
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    (normalized, is_reply)
}

/// Keyed hashes of every address in these header values (`From`, `To`, …),
/// bare and lower-cased, de-duplicated. `compute_address_hash` normalizes case
/// and whitespace, so only the display name and list syntax are removed here.
fn correspondent_hashes(headers: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in headers {
        for address in bare_addresses(value) {
            if let Some(hash) = compute_address_hash(&address).ok().flatten()
                && !out.contains(&hash)
            {
                out.push(hash);
            }
        }
    }
    out
}

/// The bare addresses in an address header: `"Griffin, Peter" <p@x.com>, b@y.com`
/// → `p@x.com`, `b@y.com`. Commas inside quotes or angle brackets don't split.
pub(crate) fn bare_addresses(value: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let (mut in_quotes, mut in_angle) = (false, false);
    for ch in value.chars() {
        match ch {
            '"' if !in_angle => in_quotes = !in_quotes,
            '<' if !in_quotes => in_angle = true,
            '>' if !in_quotes => in_angle = false,
            _ => {}
        }
        if ch == ',' && !in_quotes && !in_angle {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    parts.push(current);
    parts
        .iter()
        .filter_map(|part| {
            let part = part.trim();
            let address = match (part.rfind('<'), part.rfind('>')) {
                (Some(open), Some(close)) if open < close => &part[open + 1..close],
                _ => part,
            };
            let address = address.trim().to_lowercase();
            address.contains('@').then_some(address)
        })
        .collect()
}

fn id_hash(id: &str) -> Option<String> {
    compute_thread_key_hash("message-id", &id.trim().to_lowercase())
        .ok()
        .flatten()
}

/// One synced email to place in a conversation.
#[derive(Clone, Copy)]
pub struct ThreadInput<'a> {
    pub email_id: i32,
    pub headers: &'a ThreadHeaders,
    pub subject: &'a str,
    pub sender: &'a str,
    /// The To header (one or more addresses), for the subject fallback's
    /// "same correspondent" test.
    pub receiver: &'a str,
    pub created_at: Option<NaiveDateTime>,
}

/// Record an email's reply information and place it in a conversation. Logs
/// and swallows errors: threading must never fail the sync that brought the
/// email in.
pub async fn assign_best_effort(pool: &PgPool, account_id: i32, input: ThreadInput<'_>) {
    let email_id = input.email_id;
    if let Err(e) = assign(pool, account_id, input).await {
        warn!(target: "worker", account_id, email_id, error = ?e, "email threading failed");
    }
}

async fn assign(pool: &PgPool, account_id: i32, input: ThreadInput<'_>) -> sqlx::Result<i32> {
    let ThreadInput {
        email_id,
        headers,
        subject,
        sender,
        receiver,
        created_at,
    } = input;
    let own_hash = headers.message_id.as_deref().and_then(id_hash);
    let in_reply_to_hash = headers.in_reply_to.as_deref().and_then(id_hash);
    let reference_hashes: Vec<String> = headers
        .references
        .iter()
        .filter_map(|r| id_hash(r))
        .collect();
    let mut parent_hashes = reference_hashes.clone();
    if let Some(h) = &in_reply_to_hash
        && !parent_hashes.contains(h)
    {
        parent_hashes.push(h.clone());
    }
    let (subject_key, is_reply) = normalize_subject(subject);
    let subject_hash = compute_thread_key_hash("subject", &subject_key)
        .ok()
        .flatten();
    let sender_hash = compute_address_hash(sender).ok().flatten();
    // Everyone on the email as bare, lower-cased addresses, so the same person
    // matches whatever display name or header form the provider stored.
    let correspondents = correspondent_hashes(&[sender, receiver]);
    let (message_id_iv, message_id_encrypted) = match headers.message_id.as_deref() {
        Some(id) => encrypt(id)
            .map(|(iv, ct)| (Some(iv), Some(ct)))
            .unwrap_or((None, None)),
        None => (None, None),
    };
    let (references_iv, references_encrypted) = if headers.references.is_empty() {
        (None, None)
    } else {
        encrypt(&headers.references.join(" "))
            .map(|(iv, ct)| (Some(iv), Some(ct)))
            .unwrap_or((None, None))
    };

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(THREAD_LOCK_CLASS)
        .bind(account_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO email_thread_meta
          (email_id, account_id, message_id_hash, in_reply_to_hash, reference_hashes,
           provider_thread_id, subject_key_hash, sender_hash, is_reply,
           message_id_iv, message_id_encrypted, references_iv, references_encrypted,
           correspondent_hashes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (email_id) DO UPDATE SET
          message_id_hash = EXCLUDED.message_id_hash,
          in_reply_to_hash = EXCLUDED.in_reply_to_hash,
          reference_hashes = EXCLUDED.reference_hashes,
          provider_thread_id = EXCLUDED.provider_thread_id,
          subject_key_hash = EXCLUDED.subject_key_hash,
          sender_hash = EXCLUDED.sender_hash,
          is_reply = EXCLUDED.is_reply,
          message_id_iv = EXCLUDED.message_id_iv,
          message_id_encrypted = EXCLUDED.message_id_encrypted,
          references_iv = EXCLUDED.references_iv,
          references_encrypted = EXCLUDED.references_encrypted,
          correspondent_hashes = EXCLUDED.correspondent_hashes
        "#,
    )
    .bind(email_id)
    .bind(account_id)
    .bind(&own_hash)
    .bind(&in_reply_to_hash)
    .bind(&reference_hashes)
    .bind(&headers.provider_thread_id)
    .bind(&subject_hash)
    .bind(&sender_hash)
    .bind(is_reply)
    .bind(&message_id_iv)
    .bind(&message_id_encrypted)
    .bind(&references_iv)
    .bind(&references_encrypted)
    .bind(&correspondents)
    .execute(&mut *tx)
    .await?;

    // Re-synced emails keep their conversation.
    let existing: Option<i32> = sqlx::query_scalar("SELECT thread_id FROM emails WHERE id = $1")
        .bind(email_id)
        .fetch_optional(&mut *tx)
        .await?
        .flatten();
    if let Some(thread_id) = existing {
        tx.commit().await?;
        return Ok(thread_id);
    }

    // Steps 1 and 2: provider id, parents, and children that arrived first.
    let mut found: Vec<i32> = if headers.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(
            r#"
            SELECT DISTINCT e.thread_id
            FROM email_thread_meta m
            JOIN emails e ON e.id = m.email_id
            WHERE m.account_id = $1 AND m.email_id <> $2 AND e.thread_id IS NOT NULL
              AND (
                   ($3::text IS NOT NULL AND m.provider_thread_id = $3)
                OR m.message_id_hash = ANY($4::text[])
                OR ($5::text IS NOT NULL
                    AND (m.in_reply_to_hash = $5 OR m.reference_hashes @> ARRAY[$5]::text[]))
              )
            "#,
        )
        .bind(account_id)
        .bind(email_id)
        .bind(&headers.provider_thread_id)
        .bind(&parent_hashes)
        .bind(&own_hash)
        .fetch_all(&mut *tx)
        .await?
    };

    // Step 3: a reply with no link, matched by subject and correspondent. Only
    // for mail the provider doesn't group itself: an email carrying a Gmail or
    // Outlook conversation id that matched nothing yet is simply the first of
    // its conversation to be threaded (the backfill runs newest first), and
    // guessing would override the provider's own, exact grouping.
    if found.is_empty()
        && is_reply
        && headers.provider_thread_id.is_none()
        && let Some(subject_hash) = &subject_hash
    {
        // Someone other than the mailbox owner must be on both emails, or every
        // same-subject email in the mailbox would match through the owner.
        let own: Option<String> =
            sqlx::query_scalar("SELECT email FROM email_accounts WHERE id = $1")
                .bind(account_id)
                .fetch_optional(&mut *tx)
                .await?;
        let own_hashes = correspondent_hashes(&[own.as_deref().unwrap_or("")]);
        let others: Vec<String> = correspondents
            .iter()
            .filter(|h| !own_hashes.contains(h))
            .cloned()
            .collect();
        if !others.is_empty() {
            // A reply answers something earlier: look back, never forward.
            let until = created_at.unwrap_or_else(|| chrono::Utc::now().naive_utc());
            let since = until - chrono::Duration::days(SUBJECT_FALLBACK_DAYS);
            let by_subject: Option<i32> = sqlx::query_scalar(
                r#"
                SELECT e.thread_id
                FROM email_thread_meta m
                JOIN emails e ON e.id = m.email_id
                WHERE m.account_id = $1 AND m.email_id <> $2 AND e.thread_id IS NOT NULL
                  AND m.subject_key_hash = $3
                  AND m.correspondent_hashes && $4::text[]
                  AND e.created_at >= $5 AND e.created_at <= $6
                ORDER BY e.created_at DESC
                LIMIT 1
                "#,
            )
            .bind(account_id)
            .bind(email_id)
            .bind(subject_hash)
            .bind(&others)
            .bind(since)
            .bind(until)
            .fetch_optional(&mut *tx)
            .await?;
            found.extend(by_subject);
        }
    }

    found.sort_unstable();
    found.dedup();
    let thread_id = match found.first() {
        Some(&keep) => {
            // This email links conversations that were apart (its parent and a
            // reply that arrived first): fold them into the oldest.
            let others: Vec<i32> = found[1..].to_vec();
            if !others.is_empty() {
                sqlx::query("UPDATE emails SET thread_id = $1 WHERE thread_id = ANY($2)")
                    .bind(keep)
                    .bind(&others)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("DELETE FROM email_threads WHERE id = ANY($1)")
                    .bind(&others)
                    .execute(&mut *tx)
                    .await?;
            }
            keep
        }
        None => sqlx::query_scalar(
            "INSERT INTO email_threads (account_id, last_message_at) VALUES ($1, $2) RETURNING id",
        )
        .bind(account_id)
        .bind(created_at)
        .fetch_one(&mut *tx)
        .await?,
    };

    sqlx::query("UPDATE emails SET thread_id = $1 WHERE id = $2")
        .bind(thread_id)
        .bind(email_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE email_threads SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1",
    )
    .bind(thread_id)
    .bind(created_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(thread_id)
}

/// Delete one of `account_id`'s emails, and its conversation too when that was
/// the conversation's last message, so deleting mail never leaves an empty
/// conversation behind. Takes the threading lock, so a sync can't place a new
/// email in the conversation between the check and the delete.
pub async fn delete_email(pool: &PgPool, account_id: i32, email_id: i32) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(THREAD_LOCK_CLASS)
        .bind(account_id)
        .execute(&mut *tx)
        .await?;
    let thread_id: Option<i32> =
        sqlx::query_scalar("DELETE FROM emails WHERE id = $1 RETURNING thread_id")
            .bind(email_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    if let Some(thread_id) = thread_id {
        sqlx::query(
            "DELETE FROM email_threads t WHERE t.id = $1 \
               AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.thread_id = t.id)",
        )
        .bind(thread_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Existing emails threaded per account per sync tick: ~100 a minute at the
/// 30s cadence, gentle on provider quotas.
const BACKFILL_BATCH: i64 = 50;
/// Concurrent provider requests within one backfill batch.
const BACKFILL_CONCURRENCY: usize = 8;

/// Thread a batch of this account's emails that predate threading, newest
/// first, by re-reading their conversation inputs from the provider. Gmail and
/// Outlook only; IMAP mail is threaded as it arrives. An email the provider no
/// longer has is recorded without inputs, so it gets a conversation of its own
/// and isn't retried every tick. Returns how many were processed.
pub async fn backfill_batch(
    pool: &PgPool,
    account_id: i32,
    provider: &crate::email::provider::MailProvider,
    access_token: &str,
) -> anyhow::Result<usize> {
    use crate::email::provider::MailProvider;
    use futures::stream::{self, StreamExt};
    if !matches!(provider, MailProvider::Google | MailProvider::Microsoft) {
        return Ok(0);
    }
    let pending: Vec<(i32, String)> = sqlx::query_as(
        r#"
        SELECT e.id, e.gmail_id
        FROM emails e
        LEFT JOIN email_thread_meta m ON m.email_id = e.id
        WHERE e.account_id = $1 AND m.email_id IS NULL AND e.gmail_id IS NOT NULL
        ORDER BY e.created_at DESC NULLS LAST
        LIMIT $2
        "#,
    )
    .bind(account_id)
    .bind(BACKFILL_BATCH)
    .fetch_all(pool)
    .await?;
    let count = pending.len();

    stream::iter(pending)
        .for_each_concurrent(BACKFILL_CONCURRENCY, |(email_id, provider_id)| async move {
            let fetched = match provider {
                MailProvider::Google => fetch_gmail_inputs(access_token, &provider_id).await,
                _ => fetch_outlook_inputs(access_token, &provider_id).await,
            };
            match fetched {
                Ok(Some((headers, subject, sender, receiver, created_at))) => {
                    assign_best_effort(
pool,
account_id,
ThreadInput {
email_id,
headers: &headers,
subject: &subject,
sender: &sender,
receiver: &receiver,
created_at,
},
)
.await;
                }
                // Gone upstream: record it so it isn't fetched again.
                Ok(None) => {
                    assign_best_effort(
pool,
account_id,
ThreadInput {
email_id,
headers: &ThreadHeaders::default(),
subject: "",
sender: "",
receiver: "",
created_at: None,
},
)
.await;
                }
                Err(e) => {
                    warn!(target: "worker", account_id, email_id, error = ?e, "threading backfill fetch failed");
                }
            }
        })
        .await;
    Ok(count)
}

/// (headers, subject, sender, receiver, created_at) re-read from the provider.
type Inputs = (ThreadHeaders, String, String, String, Option<NaiveDateTime>);

async fn fetch_gmail_inputs(token: &str, gmail_id: &str) -> anyhow::Result<Option<Inputs>> {
    match crate::email::sync::fetch_headers_only(token, gmail_id).await {
        Ok((_, sender, receiver, subject, created_at, _, _, headers)) => {
            Ok(Some((headers, subject, sender, receiver, Some(created_at))))
        }
        Err(e) if format!("{e}").contains("HTTP 404") => Ok(None),
        Err(e) => Err(e),
    }
}

async fn fetch_outlook_inputs(token: &str, message_id: &str) -> anyhow::Result<Option<Inputs>> {
    let url = format!(
        "{}/v1.0/me/messages/{}?$select=conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime",
        crate::external::microsoft_graph_base(),
        message_id
    );
    let resp = crate::email::oauth::HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .send()
        .await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        anyhow::bail!("graph message fetch failed: HTTP {}", resp.status());
    }
    let m: serde_json::Value = resp.json().await?;
    let headers = ThreadHeaders::from_raw(
        m["internetMessageId"].as_str(),
        None,
        None,
        m["conversationId"].as_str(),
    );
    let subject = m["subject"].as_str().unwrap_or("").to_string();
    let sender = m["from"]["emailAddress"]["address"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let receiver = m["toRecipients"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|r| r["emailAddress"]["address"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let created_at = m["receivedDateTime"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.naive_utc());
    Ok(Some((headers, subject, sender, receiver, created_at)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bracketed_ids_and_tolerates_junk() {
        assert_eq!(
            parse_message_ids("<a@x.com> <b@y.com>\r\n\t<c@z.com>"),
            ["a@x.com", "b@y.com", "c@z.com"]
        );
        assert_eq!(parse_message_ids("  <  spaced@x.com > "), ["spaced@x.com"]);
        assert_eq!(
            parse_message_ids("bare@x.com, other@y.com"),
            ["bare@x.com", "other@y.com"]
        );
        assert!(parse_message_ids("").is_empty());
        assert!(parse_message_ids("<>").is_empty());
    }

    #[test]
    fn in_reply_to_takes_the_last_id() {
        let h = ThreadHeaders::from_raw(Some("<me@x>"), Some("<a@x> <parent@x>"), None, Some(" "));
        assert_eq!(h.message_id.as_deref(), Some("me@x"));
        assert_eq!(h.in_reply_to.as_deref(), Some("parent@x"));
        assert_eq!(h.provider_thread_id, None, "blank provider id is ignored");
    }

    #[test]
    fn strips_reply_and_forward_prefixes() {
        assert_eq!(
            normalize_subject("Re: Re: FWD:  Invoice   42"),
            ("invoice 42".into(), true)
        );
        assert_eq!(normalize_subject("AW: Angebot"), ("angebot".into(), true));
        assert_eq!(normalize_subject("Re[2]: Hello"), ("hello".into(), true));
        assert_eq!(normalize_subject("Invoice"), ("invoice".into(), false));
        // A word that merely starts like a prefix is not one.
        assert_eq!(
            normalize_subject("Return policy"),
            ("return policy".into(), false)
        );
        assert_eq!(
            normalize_subject("Svensk: hej"),
            ("svensk: hej".into(), false)
        );
    }
}
