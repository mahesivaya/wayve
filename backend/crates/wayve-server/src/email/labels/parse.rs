//! Normalize a user's free-text "senders" description into a list of lowercase
//! email addresses and bare domains, used to match an email's `From` address.
//!
//! Strategy mirrors `tasks/suggest/mapping.rs`: a cheap deterministic extraction
//! runs first (and is the floor + the fallback), then the in-app AI re-interprets
//! the text to expand loose phrases ("all github notifications" -> "github.com").
//! The AI output is sanitized through the same validator and *unioned* with the
//! deterministic result, so explicit addresses the user typed can never be
//! dropped by a lazy model. Never errors — worst case an empty list.

use crate::prelude::*;
use std::collections::HashSet;

/// Cap on how many senders a single label matches — bounds the OR-of-LIKE the
/// inbox query builds, and the prompt size.
pub const MAX_SENDERS: usize = 50;

/// Normalize free text into lowercase addresses/bare-domains. Never errors.
pub async fn normalize_senders(pool: &PgPool, user_id: i32, raw: &str) -> Vec<String> {
    let deterministic = regex_extract(raw);

    let ai = crate::ai::provider::resolve_ai_for_user(pool, user_id)
        .await
        .ok()
        .flatten();
    let Some(ai) = ai else {
        return deterministic;
    };

    let ai_entries = match ai_normalize(&ai, raw).await {
        Some(entries) => entries,
        None => return deterministic,
    };

    // Union: deterministic first (authoritative for explicit addresses), then
    // AI additions (phrase expansions). Dedup preserving order, cap the total.
    union_capped(deterministic, ai_entries)
}

/// Ask the AI to turn the description into a JSON array of addresses/domains.
/// Returns `None` when the call fails or yields nothing usable — the caller
/// then relies on the deterministic extraction.
async fn ai_normalize(ai: &crate::ai::provider::ResolvedAi, raw: &str) -> Option<Vec<String>> {
    let prompt = format!(
        "You convert a description of email senders into a JSON array of lowercase \
         email addresses and/or bare domains, used to match an email's \"From\" address.\n\
         Rules:\n\
         - Output ONLY a JSON array of strings. No prose, no code fences.\n\
         - Each element is either a full address (e.g. \"jobs@lever.co\") or a bare \
           domain (e.g. \"github.com\"). Never include a scheme, \"mailto:\", display \
           names, angle brackets, or a lone \"@\".\n\
         - Expand well-known brand phrases to their notification domains \
           (e.g. \"github\" -> \"github.com\", \"gitlab\" -> \"gitlab.com\").\n\
         - If nothing is identifiable, return [].\n\n\
         Description:\n{raw}"
    );
    let reply = crate::ai::agent::complete(ai, &prompt).await.ok()?;
    let slice = json_array_slice(&reply)?;
    let arr: Vec<String> = serde_json::from_str(slice).unwrap_or_default();
    Some(arr.iter().filter_map(|s| sanitize_entry(s)).collect())
}

/// Deterministic extraction: split on separators and keep tokens that sanitize
/// to a valid address or bare domain. Handles `"a@b.com, c@d.com"` with zero AI.
fn regex_extract(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for tok in raw.split(|c: char| matches!(c, ',' | ';' | ' ' | '\t' | '\n' | '\r' | '<' | '>' | '"' | '\'' | '(' | ')' | '[' | ']')) {
        if let Some(entry) = sanitize_entry(tok)
            && seen.insert(entry.clone())
        {
            out.push(entry);
            if out.len() >= MAX_SENDERS {
                break;
            }
        }
    }
    out
}

/// Union two lists, dedup preserving order (first list authoritative), cap length.
fn union_capped(first: Vec<String>, second: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in first.into_iter().chain(second) {
        if seen.insert(entry.clone()) {
            out.push(entry);
            if out.len() >= MAX_SENDERS {
                break;
            }
        }
    }
    out
}

/// Clean a single token into a valid lowercase address or bare domain, or `None`.
/// Strips `mailto:`, angle brackets, quotes, and trailing punctuation.
fn sanitize_entry(token: &str) -> Option<String> {
    let s = token
        .trim()
        .trim_matches(|c: char| matches!(c, '<' | '>' | '"' | '\'' | ',' | ';' | '.' | ':'))
        .to_ascii_lowercase();
    let s = s.strip_prefix("mailto:").unwrap_or(&s).trim();
    if s.is_empty() {
        return None;
    }

    if let Some((local, domain)) = s.split_once('@') {
        // Reject a second '@' or an empty local part.
        if local.is_empty() || domain.contains('@') || !is_valid_domain(domain) {
            return None;
        }
        Some(format!("{local}@{domain}"))
    } else if is_valid_domain(s) {
        Some(s.to_string())
    } else {
        None
    }
}

/// A bare domain: at least one dot, only `[a-z0-9.-]`, no leading/trailing dot or
/// hyphen, and a plausible (>= 2 char, alphabetic) TLD.
fn is_valid_domain(domain: &str) -> bool {
    if domain.len() < 3 || domain.starts_with(['.', '-']) || domain.ends_with(['.', '-']) {
        return false;
    }
    if !domain
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return false;
    }
    match domain.rsplit_once('.') {
        Some((_, tld)) => tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_lowercase()),
        None => false,
    }
}

/// The first `[` … `]` slice of a reply, tolerating code fences / prose.
fn json_array_slice(reply: &str) -> Option<&str> {
    let start = reply.find('[')?;
    let end = reply.rfind(']')?;
    (end > start).then(|| &reply[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_explicit_address_list() {
        let got = regex_extract("notifications@github.com, jobs@lever.co");
        assert_eq!(got, vec!["notifications@github.com", "jobs@lever.co"]);
    }

    #[test]
    fn extracts_from_messy_input_with_brackets_and_mailto() {
        let got = regex_extract("Recruiter <mailto:jobs@lever.co>; team@acme.io");
        assert_eq!(got, vec!["jobs@lever.co", "team@acme.io"]);
    }

    #[test]
    fn extracts_bare_domains() {
        let got = regex_extract("github.com gitlab.com");
        assert_eq!(got, vec!["github.com", "gitlab.com"]);
    }

    #[test]
    fn drops_non_addresses_and_words() {
        // "all", "notifications" are plain words (no dot / no @) and dropped.
        let got = regex_extract("all github notifications");
        assert!(got.is_empty());
    }

    #[test]
    fn rejects_double_at_and_empty_local() {
        assert_eq!(sanitize_entry("a@@b.com"), None);
        assert_eq!(sanitize_entry("@github.com"), None);
    }

    #[test]
    fn tld_must_be_alphabetic() {
        assert_eq!(sanitize_entry("1.2.3.4"), None);
        assert_eq!(sanitize_entry("host.local"), Some("host.local".to_string()));
    }

    #[test]
    fn union_dedups_preserving_first() {
        let got = union_capped(
            vec!["github.com".to_string()],
            vec!["github.com".to_string(), "gitlab.com".to_string()],
        );
        assert_eq!(got, vec!["github.com", "gitlab.com"]);
    }

    #[test]
    fn json_slice_tolerates_fences() {
        let slice = json_array_slice("```json\n[\"github.com\"]\n```").unwrap();
        assert_eq!(slice, "[\"github.com\"]");
    }
}
