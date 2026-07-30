//! Email contacts projection — the searchable address book behind the compose
//! "To" typeahead.
//!
//! The `emails` table stores sender/receiver encrypted at rest (only an
//! exact-match HMAC hash is queryable), so it cannot back a substring search.
//! This module maintains a plaintext, per-user `email_contacts` table, fed from
//! the sync/insert path (`record_from_addresses`) and a one-time startup
//! backfill (`backfill`, in `repo.rs`, which owns the address decryptors).
//!
//! Writes go through the plain (superuser) pool, which bypasses RLS the same way
//! the `emails` upsert does; the user-facing read scopes explicitly by `user_id`.

use crate::prelude::*;
use std::collections::HashMap;
use tracing::warn;

/// Splits `"Display Name <addr@x>"` or a bare `"addr@x"` into a lowercased
/// address and a display name (empty when absent). Returns `None` when there is
/// no usable address.
pub fn parse_contact(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    // "Name <addr>" form.
    if let (Some(lt), Some(gt)) = (raw.rfind('<'), raw.rfind('>'))
        && lt < gt
    {
        let addr = raw[lt + 1..gt].trim();
        if addr.contains('@') && !addr.contains(' ') {
            let name = raw[..lt].trim().trim_matches('"').trim();
            return Some((addr.to_lowercase(), name.to_string()));
        }
    }
    // Bare address.
    if raw.contains('@') && !raw.contains(char::is_whitespace) {
        return Some((raw.to_lowercase(), String::new()));
    }
    None
}

/// Aggregates raw sender/receiver strings into `address -> (best name, count)`,
/// skipping the account owner's own address and anything unparseable.
fn aggregate<'a>(
    raw_addresses: impl IntoIterator<Item = &'a str>,
    own_email: &str,
) -> HashMap<String, (String, i32)> {
    let own = own_email.trim().to_lowercase();
    let mut agg: HashMap<String, (String, i32)> = HashMap::new();
    for raw in raw_addresses {
        if let Some((addr, name)) = parse_contact(raw) {
            if addr == own {
                continue;
            }
            let entry = agg.entry(addr).or_insert((String::new(), 0));
            entry.1 += 1;
            if entry.0.is_empty() && !name.is_empty() {
                entry.0 = name;
            }
        }
    }
    agg
}

/// Best-effort: upsert the given correspondent addresses into `email_contacts`
/// for the account's owning user. Resolves the owner and own address from
/// `account_id`. Never errors the caller — logs and returns on any failure so a
/// sync tick is never failed by contact bookkeeping.
pub async fn record_from_addresses<'a>(
    pool: &PgPool,
    account_id: i32,
    raw_addresses: impl IntoIterator<Item = &'a str>,
) {
    let owner = sqlx::query("SELECT user_id, email FROM email_accounts WHERE id = $1")
        .bind(account_id)
        .fetch_optional(pool)
        .await;
    let row = match owner {
        Ok(Some(row)) => row,
        Ok(None) => return,
        Err(e) => {
            warn!(target: "worker", account_id, error = ?e, "contacts: owner lookup failed");
            return;
        }
    };
    let user_id: i32 = row.get("user_id");
    let own_email: String = row.get("email");

    let agg = aggregate(raw_addresses, &own_email);
    for (address, (display_name, count)) in agg {
        upsert(pool, user_id, &address, &display_name, count, true).await;
    }
}

/// Upsert one contact. When `increment` is true (live sync), the message count
/// accumulates; when false (backfill), an existing row is left untouched so a
/// re-run can't inflate counts. Best-effort — logs on failure.
#[allow(clippy::too_many_arguments)]
pub async fn upsert(
    pool: &PgPool,
    user_id: i32,
    address: &str,
    display_name: &str,
    count: i32,
    increment: bool,
) {
    let sql = if increment {
        "INSERT INTO email_contacts (user_id, address, display_name, message_count) \
         VALUES ($1, $2, NULLIF($3, ''), $4) \
         ON CONFLICT (user_id, address) DO UPDATE \
         SET message_count = email_contacts.message_count + EXCLUDED.message_count, \
             last_seen_at = NOW(), \
             display_name = COALESCE(email_contacts.display_name, EXCLUDED.display_name)"
    } else {
        "INSERT INTO email_contacts (user_id, address, display_name, message_count) \
         VALUES ($1, $2, NULLIF($3, ''), $4) \
         ON CONFLICT (user_id, address) DO NOTHING"
    };
    if let Err(e) = sqlx::query(sql)
        .bind(user_id)
        .bind(address)
        .bind(display_name)
        .bind(count.max(1))
        .execute(pool)
        .await
    {
        warn!(target: "worker", user_id, error = ?e, "email_contacts upsert failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_contact_named_and_bare() {
        assert_eq!(
            parse_contact("Alice Chen <Alice@Acme.com>"),
            Some(("alice@acme.com".to_string(), "Alice Chen".to_string()))
        );
        assert_eq!(
            parse_contact("bob@x.com"),
            Some(("bob@x.com".to_string(), String::new()))
        );
        assert_eq!(
            parse_contact("\"Quoted Name\" <q@x.com>"),
            Some(("q@x.com".to_string(), "Quoted Name".to_string()))
        );
    }

    #[test]
    fn parse_contact_rejects_non_addresses() {
        assert_eq!(parse_contact(""), None);
        assert_eq!(parse_contact("   "), None);
        assert_eq!(parse_contact("no-at-sign"), None);
        assert_eq!(parse_contact("<not an email>"), None);
    }

    #[test]
    fn aggregate_skips_own_and_counts() {
        let addrs = vec![
            "Alice <alice@x.com>",
            "alice@x.com",
            "me@own.com",
            "Me <me@own.com>",
        ];
        let agg = aggregate(addrs, "me@own.com");
        assert_eq!(agg.len(), 1);
        let (name, count) = &agg["alice@x.com"];
        assert_eq!(name, "Alice");
        assert_eq!(*count, 2);
    }
}
