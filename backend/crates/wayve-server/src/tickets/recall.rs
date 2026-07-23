//! Recall past fixes: given a ticket to fix, ask the platform model (Claude in
//! prod) which previously-resolved ticket is the same kind of issue, so the
//! AI-fix pipeline can reuse that solution as a worked example. Claude-in-prompt
//! matching — no embeddings — over the small set of resolved tickets. The fix
//! *code* stays in Git; a match returns the resolved ticket id, and the caller
//! loads its stored `resolution_summary`/`resolution_commit` pointer.

use crate::ai::{agent, provider};
use crate::prelude::*;

/// A resolved ticket that carries a fix pointer, used as a recall candidate.
pub struct ResolvedTicket {
    pub id: i32,
    pub name: String,
    pub description: String,
    pub summary: String,
}

/// The id of the resolved ticket most similar to `target`, or None when nothing
/// matches / no AI is configured. Best-effort.
pub async fn find_similar_fix(
    pool: &PgPool,
    target: (i32, &str, &str),
    candidates: &[ResolvedTicket],
) -> Option<i32> {
    if candidates.is_empty() {
        return None;
    }
    let ai = provider::resolve_platform_ai(pool).await.ok().flatten()?;

    let (tid, tname, tdesc) = target;
    let listing = candidates
        .iter()
        .map(|c| {
            let d: String = c.description.chars().take(300).collect();
            let s: String = c.summary.chars().take(300).collect();
            format!("#{} {}\nissue: {d}\nfix: {s}", c.id, c.name)
        })
        .collect::<Vec<_>>()
        .join("\n---\n");

    let new_desc: String = tdesc.chars().take(600).collect();
    let prompt = format!(
        "A new engineering ticket needs fixing. Below are previously RESOLVED tickets \
         and how each was fixed. Pick the ONE resolved ticket whose issue is the same \
         kind of problem as the new ticket, so its fix can be reused as a guide. \
         Reply with ONLY JSON: {{\"match\": <resolved ticket number>}} — or \
         {{\"match\": null}} if none is a good match. No prose.\n\n\
         New ticket #{tid} {tname}\n{new_desc}\n\n\
         Resolved tickets:\n{listing}"
    );

    let reply = agent::complete(&ai, &prompt).await.ok()?;
    let known: std::collections::HashSet<i32> = candidates.iter().map(|c| c.id).collect();
    parse_match(&reply).filter(|id| known.contains(id))
}

/// Pull the integer after `"match"` from the reply, ignoring `null`/prose.
fn parse_match(reply: &str) -> Option<i32> {
    let start = reply.find('{')?;
    let end = reply.rfind('}')?;
    if end <= start {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&reply[start..=end]).ok()?;
    value.get("match")?.as_i64().map(|n| n as i32)
}
