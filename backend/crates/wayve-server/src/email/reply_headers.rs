//! The headers that make an outgoing reply join the conversation it answers.
//!
//! A reply names the email it answers (`SendEmailRequest::reply_to_email_id`).
//! From the threading metadata sync stored for that email (`email_thread_meta`,
//! see `email::threading`) this builds `In-Reply-To` / `References`, which every
//! mail client threads on, plus Gmail's `threadId` so the reply also lands in the
//! sender's own Gmail conversation.
//!
//! Every value here came from *incoming* mail, which an attacker controls, and is
//! about to be written into an outgoing header. So nothing is copied through
//! unchecked: a message id that isn't a plain `<local@domain>` (no whitespace, no
//! control characters, bounded length) is dropped, never "fixed up". The lookup
//! only ever reads the caller's own mailbox, under row-level security. And all of
//! it is best-effort: when anything is missing or fails, the reply is simply
//! sent unthreaded, exactly as before this existed.

use crate::prelude::*;

use crate::email::threading::parse_message_ids;
use tracing::warn;
use wayve_security::encryption::decrypt;

/// `References` keeps the first id (the conversation root) plus the most recent
/// ones, so a very long conversation can't grow an unbounded header.
const MAX_REFERENCES: usize = 20;
/// Longest message id accepted, without brackets. Real ids are far shorter.
const MAX_MESSAGE_ID_LEN: usize = 250;
/// Gmail thread ids are short hex strings; anything longer is not one.
const MAX_THREAD_ID_LEN: usize = 64;

/// Threading headers for one outgoing reply. Built only by [`load`], from
/// validated values, so a client can never supply them directly.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReplyHeaders {
    /// `<id>` of the email being answered.
    pub in_reply_to: String,
    /// Space-separated `<id>` list, ending with `in_reply_to`.
    pub references: String,
    /// Gmail's conversation id, when the original came from Gmail.
    pub gmail_thread_id: Option<String>,
}

/// A message id safe to write into a header, as `<local@domain>`, or `None`.
pub fn clean_message_id(raw: &str) -> Option<String> {
    let id = raw.trim().trim_start_matches('<').trim_end_matches('>');
    let valid = !id.is_empty()
        && id.len() <= MAX_MESSAGE_ID_LEN
        && !id
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '<' || c == '>')
        && matches!(id.split_once('@'), Some((local, domain)) if !local.is_empty() && !domain.is_empty());
    valid.then(|| format!("<{id}>"))
}

/// Gmail's `threadId`, if it looks like one (alphanumerics, `-`, `_`).
pub fn clean_thread_id(raw: &str) -> Option<String> {
    let id = raw.trim();
    let valid = !id.is_empty()
        && id.len() <= MAX_THREAD_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    valid.then(|| id.to_string())
}

/// `References` for a reply: the parent's references, then the parent itself,
/// de-duplicated, invalid ids dropped, trimmed to the root plus the newest.
pub fn build_references(parent_references: &[String], parent_id: &str) -> String {
    let mut ids: Vec<String> = Vec::new();
    for id in parent_references
        .iter()
        .filter_map(|r| clean_message_id(r))
        .chain(std::iter::once(parent_id.to_string()))
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.len() > MAX_REFERENCES {
        let root = ids[0].clone();
        let newest = ids.split_off(ids.len() - (MAX_REFERENCES - 1));
        ids = std::iter::once(root).chain(newest).collect();
    }
    ids.join(" ")
}

/// A header value with every control character (CR and LF included) turned into
/// a space, so it can't end its header line and start a forged one. Applied to
/// the user-editable To/Cc/Bcc/Subject of every outgoing standard email — the
/// reply subject is prefilled from the incoming email, which an attacker writes.
pub fn clean_header_value(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// Threading headers for a reply to `email_id`, read from `account_id`'s own
/// mailbox as `user_id` (row-level security on). `None` means "send unthreaded":
/// the email isn't in this mailbox, has no stored message id, or any step fails.
pub async fn load(
    pool: &PgPool,
    user_id: i32,
    account_id: i32,
    email_id: i32,
) -> Option<ReplyHeaders> {
    type Row = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row = crate::db::with_rls_user_tx(pool, user_id, |mut tx| async move {
        let row: Option<Row> = sqlx::query_as(
            "SELECT m.message_id_iv, m.message_id_encrypted, \
                    m.references_iv, m.references_encrypted, m.provider_thread_id \
             FROM email_thread_meta m \
             JOIN emails e ON e.id = m.email_id \
             WHERE m.email_id = $1 AND e.account_id = $2 AND m.account_id = $2",
        )
        .bind(email_id)
        .bind(account_id)
        .fetch_optional(&mut *tx)
        .await?;
        Ok((tx, row))
    })
    .await;

    let (id_iv, id_ct, refs_iv, refs_ct, thread_id) = match row {
        Ok(Some(row)) => row,
        Ok(None) => return None,
        Err(e) => {
            warn!(target: "gmail", email_id, error = ?e, "reply headers lookup failed; sending unthreaded");
            return None;
        }
    };

    let parent_id = match (id_iv, id_ct) {
        (Some(iv), Some(ct)) => match decrypt(&iv, &ct) {
            Ok(id) => clean_message_id(&id)?,
            Err(e) => {
                warn!(target: "gmail", email_id, error = %e, "reply message-id decrypt failed; sending unthreaded");
                return None;
            }
        },
        _ => return None,
    };
    let parent_references = match (refs_iv, refs_ct) {
        (Some(iv), Some(ct)) => decrypt(&iv, &ct)
            .map(|refs| parse_message_ids(&refs))
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    Some(ReplyHeaders {
        references: build_references(&parent_references, &parent_id),
        in_reply_to: parent_id,
        gmail_thread_id: thread_id.as_deref().and_then(clean_thread_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_ids_must_be_plain_local_at_domain() {
        assert_eq!(clean_message_id("<a.b@x.com>"), Some("<a.b@x.com>".into()));
        assert_eq!(clean_message_id("a.b@x.com"), Some("<a.b@x.com>".into()));
        // A line break inside the brackets is exactly the header-injection shape.
        assert_eq!(clean_message_id("<a\r\nBcc: evil@x.com>"), None);
        assert_eq!(clean_message_id("<a\nb@x.com>"), None);
        assert_eq!(clean_message_id("<a b@x.com>"), None);
        assert_eq!(clean_message_id("<no-at-sign>"), None);
        assert_eq!(clean_message_id("<@x.com>"), None);
        assert_eq!(clean_message_id("<a@>"), None);
        assert_eq!(clean_message_id(""), None);
        assert_eq!(
            clean_message_id(&format!("<{}@x.com>", "a".repeat(300))),
            None
        );
    }

    #[test]
    fn thread_ids_are_short_and_plain() {
        assert_eq!(
            clean_thread_id("19f7c7d35b08fe0c"),
            Some("19f7c7d35b08fe0c".into())
        );
        assert_eq!(clean_thread_id("abc\r\n"), Some("abc".into()));
        assert_eq!(clean_thread_id("a b"), None);
        assert_eq!(clean_thread_id("a\"b"), None);
        assert_eq!(clean_thread_id(&"a".repeat(65)), None);
    }

    #[test]
    fn references_end_with_the_parent_drop_junk_and_dedupe() {
        let refs = vec![
            "root@x.com".to_string(),
            "bad\r\nid@x.com".to_string(),
            "mid@x.com".to_string(),
            "parent@x.com".to_string(),
        ];
        assert_eq!(
            build_references(&refs, "<parent@x.com>"),
            "<root@x.com> <mid@x.com> <parent@x.com>"
        );
    }

    #[test]
    fn references_keep_the_root_and_the_newest_when_capped() {
        let refs: Vec<String> = (0..40).map(|i| format!("m{i}@x.com")).collect();
        let built = build_references(&refs, "<parent@x.com>");
        let ids: Vec<&str> = built.split(' ').collect();
        assert_eq!(ids.len(), MAX_REFERENCES);
        assert_eq!(ids[0], "<m0@x.com>");
        assert_eq!(*ids.last().unwrap_or(&""), "<parent@x.com>");
    }

    #[test]
    fn header_values_lose_line_breaks() {
        assert_eq!(
            clean_header_value("Re: hi\r\nBcc: evil@x.com"),
            "Re: hi  Bcc: evil@x.com"
        );
        assert_eq!(clean_header_value("plain"), "plain");
    }
}
