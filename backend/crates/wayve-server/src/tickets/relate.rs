//! AI relationship detection for Workspace tickets: ask the platform model
//! (Claude in prod) to group tickets that are **duplicates** (the same issue
//! reported more than once) or **similar** (different tickets sharing the same
//! kind of problem / root cause). Labels only — the caller never merges or
//! closes anything. Best-effort: any failure yields no groups.

use crate::ai::{agent, provider};
use crate::prelude::*;

/// A group of related ticket ids and how they relate.
pub struct Group {
    pub kind: String, // "duplicate" | "similar"
    pub ids: Vec<i32>,
}

/// Ask Claude to cluster the given tickets. Returns the groups it found (each
/// with ≥2 known ids and a valid kind); empty when no AI is configured, the
/// reply can't be parsed, or nothing relates.
pub async fn find_groups(pool: &PgPool, tickets: &[(i32, String, String)]) -> Vec<Group> {
    if tickets.len() < 2 {
        return Vec::new();
    }
    let Some(ai) = provider::resolve_platform_ai(pool).await.ok().flatten() else {
        return Vec::new();
    };

    let listing = tickets
        .iter()
        .map(|(id, name, desc)| {
            // Trim descriptions so a big backlog stays within a sensible prompt.
            let d: String = desc.chars().take(400).collect();
            format!("#{id} {name}\n{d}")
        })
        .collect::<Vec<_>>()
        .join("\n---\n");

    let prompt = format!(
        "You are analysing an engineering/support ticket backlog for relationships.\n\
         Group tickets that are either:\n\
         - \"duplicate\": the SAME underlying issue reported more than once (redundant), or\n\
         - \"similar\": DIFFERENT tickets that share the same kind of problem / root cause / pattern.\n\
         Only group tickets that genuinely relate; leave unrelated tickets out. A group needs \
         at least 2 tickets. Each ticket belongs to AT MOST ONE group — if a set of tickets \
         are duplicates, put them ONLY in a duplicate group, not also a similar one. Prefer \
         'duplicate' over 'similar' when both could apply.\n\
         Reply with ONLY a JSON array, no prose, of objects: \
         [{{\"kind\":\"duplicate\"|\"similar\",\"ids\":[<ticket numbers>]}}]. \
         Use the numbers after '#'. If nothing relates, reply [].\n\n\
         Tickets:\n{listing}"
    );

    let Ok(reply) = agent::complete(&ai, &prompt).await else {
        return Vec::new();
    };
    parse_groups(&reply, tickets)
}

/// Extract the JSON array from the reply and keep only well-formed groups whose
/// ids are known tickets (dropping singletons, unknown ids, and bad kinds).
fn parse_groups(reply: &str, tickets: &[(i32, String, String)]) -> Vec<Group> {
    let known: std::collections::HashSet<i32> = tickets.iter().map(|(id, _, _)| *id).collect();
    let Some(json) = slice_json_array(reply) else {
        return Vec::new();
    };
    let Ok(raw) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for g in raw {
        let kind = g.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        if kind != "duplicate" && kind != "similar" {
            continue;
        }
        let mut ids: Vec<i32> = g
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_i64().map(|n| n as i32))
                    .filter(|id| known.contains(id))
                    .collect()
            })
            .unwrap_or_default();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() >= 2 {
            out.push(Group {
                kind: kind.to_string(),
                ids,
            });
        }
    }
    out
}

/// The substring from the first `[` to the last `]`, so a model that wraps its
/// JSON in prose or a code fence still parses.
fn slice_json_array(s: &str) -> Option<&str> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    (end > start).then(|| &s[start..=end])
}
