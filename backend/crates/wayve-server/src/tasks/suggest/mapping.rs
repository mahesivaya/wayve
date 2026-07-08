//! Map a task ("user story") to the repo files it will most likely touch.
//!
//! Strategy: keyword-rank the repo tree first (cheap, deterministic), hand the
//! top slice to the in-app AI to re-rank with real understanding, and fall back
//! to the keyword order when the AI is unavailable or returns nothing usable.
//! The AI only ever chooses from the candidate list, so it can't invent paths.

use crate::prelude::*;
use std::collections::HashSet;

/// Most files we map a single task to.
pub const MAX_FILES: usize = 8;
/// How many keyword-ranked candidates to show the AI (bounds the prompt).
const AI_CANDIDATE_LIMIT: usize = 120;

/// The outcome of mapping: the chosen files and whether the AI produced them
/// (vs. the keyword fallback) — surfaced so the endpoint can explain itself.
pub struct Mapping {
    pub files: Vec<String>,
    pub used_ai: bool,
}

/// Lowercase alphanumeric words of length ≥ 3, from free text.
fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.len() >= 3)
        .map(|w| w.to_ascii_lowercase())
        .collect()
}

/// Keyword-overlap score of a path against the task tokens. The final path
/// segment (filename) is weighted more heavily than parent directories.
fn keyword_score(path: &str, toks: &[String]) -> i32 {
    let lower = path.to_ascii_lowercase();
    let filename = lower.rsplit('/').next().unwrap_or(&lower);
    let mut score = 0;
    for t in toks {
        if filename.contains(t.as_str()) {
            score += 3;
        } else if lower.contains(t.as_str()) {
            score += 1;
        }
    }
    score
}

/// Paths ranked by keyword overlap (desc), ties broken by shorter path. Paths
/// with zero overlap are dropped.
fn keyword_ranked(paths: &[String], toks: &[String]) -> Vec<String> {
    let mut scored: Vec<(i32, &String)> = paths
        .iter()
        .map(|p| (keyword_score(p, toks), p))
        .filter(|(s, _)| *s > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.len().cmp(&b.1.len())));
    scored.into_iter().map(|(_, p)| p.clone()).collect()
}

/// Map a story to files. Never errors — the worst case is an empty file list
/// (e.g. a repo with no keyword overlap and no AI configured).
pub async fn map_story_to_files(
    pool: &PgPool,
    user_id: i32,
    summary: &str,
    description: &str,
    tree: &[String],
) -> Mapping {
    let toks = tokens(&format!("{summary} {description}"));
    let ranked = keyword_ranked(tree, &toks);

    // Candidate subset the AI ranks over — the keyword hits, or (when nothing
    // matched) the head of the tree so the AI still has something to work with.
    let candidates: Vec<String> = if ranked.is_empty() {
        tree.iter().take(AI_CANDIDATE_LIMIT).cloned().collect()
    } else {
        ranked.iter().take(AI_CANDIDATE_LIMIT).cloned().collect()
    };

    if !candidates.is_empty()
        && let Some(ai_files) = ai_pick(pool, user_id, summary, description, &candidates).await
        && !ai_files.is_empty()
    {
        return Mapping {
            files: ai_files,
            used_ai: true,
        };
    }

    Mapping {
        files: ranked.into_iter().take(MAX_FILES).collect(),
        used_ai: false,
    }
}

/// Ask the in-app AI to pick the most relevant files from `candidates`. Returns
/// `None` when no provider is configured or the call fails — the caller then
/// uses the keyword fallback.
async fn ai_pick(
    pool: &PgPool,
    user_id: i32,
    summary: &str,
    description: &str,
    candidates: &[String],
) -> Option<Vec<String>> {
    let ai = crate::ai::provider::resolve_ai_for_user(pool, user_id)
        .await
        .ok()??;
    let list = candidates.join("\n");
    let prompt = format!(
        "You map a software task to the files most likely to change to implement it.\n\
         Task summary: {summary}\n\
         Task description: {description}\n\n\
         Candidate files (choose ONLY from this list, copy paths verbatim):\n{list}\n\n\
         Return a JSON array of at most {MAX_FILES} file paths, most relevant first. \
         Return [] if none are relevant. Output ONLY the JSON array, no prose."
    );
    let reply = crate::ai::agent::complete(&ai, &prompt).await.ok()?;
    Some(parse_paths(&reply, candidates))
}

/// Extract a JSON array of strings from the model reply and keep only paths that
/// are in the candidate set (guards against hallucinated paths), capped to
/// [`MAX_FILES`]. Tolerates code fences / surrounding prose.
fn parse_paths(reply: &str, candidates: &[String]) -> Vec<String> {
    let allowed: HashSet<&str> = candidates.iter().map(String::as_str).collect();
    let Some(slice) = json_array_slice(reply) else {
        return Vec::new();
    };
    let arr: Vec<String> = serde_json::from_str(slice).unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    arr.into_iter()
        .filter(|p| allowed.contains(p.as_str()) && seen.insert(p.clone()))
        .take(MAX_FILES)
        .collect()
}

/// The first `[` … `]` slice of a string, or `None`. Lets us pull the array out
/// of a reply that wrapped it in ```json fences or explanatory text.
fn json_array_slice(reply: &str) -> Option<&str> {
    let start = reply.find('[')?;
    let end = reply.rfind(']')?;
    if end > start {
        Some(&reply[start..=end])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyword_ranking_prefers_filename_hits() {
        let tree = vec![
            "src/email/sync.rs".to_string(),
            "src/chat/websocket.rs".to_string(),
            "docs/email.md".to_string(),
        ];
        let toks = tokens("Fix email sync worker");
        let ranked = keyword_ranked(&tree, &toks);
        assert_eq!(
            ranked.first().map(String::as_str),
            Some("src/email/sync.rs")
        );
        // The chat file shares no tokens and is dropped.
        assert!(!ranked.iter().any(|p| p.contains("websocket")));
    }

    #[test]
    fn parse_paths_filters_hallucinations_and_fences() {
        let candidates = vec!["a/b.rs".to_string(), "c/d.rs".to_string()];
        let reply = "```json\n[\"a/b.rs\", \"x/y.rs\", \"c/d.rs\"]\n```";
        let got = parse_paths(reply, &candidates);
        assert_eq!(got, vec!["a/b.rs".to_string(), "c/d.rs".to_string()]);
    }

    #[test]
    fn parse_paths_handles_garbage() {
        let candidates = vec!["a/b.rs".to_string()];
        assert!(parse_paths("no array here", &candidates).is_empty());
    }
}
