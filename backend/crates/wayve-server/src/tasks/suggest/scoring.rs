//! Turn the commits that touched the mapped files into a ranked list of
//! authors. Deterministic and explainable: each author's score is the sum of a
//! recency weight over their commits, so more edits and more-recent edits rank
//! higher. Raw counts are kept so the endpoint can say *why*.

use super::github::FileCommit;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

/// One ranked author with the sub-scores behind the ranking.
pub struct AuthorScore {
    /// GitHub login, when the commit carried one.
    pub login: Option<String>,
    /// Commit author display name — the label when there's no login.
    pub name: Option<String>,
    pub score: f64,
    pub commits: u32,
    /// Commits within the last 90 days (drives the "N recent" explanation).
    pub recent_commits: u32,
    pub last_activity: Option<DateTime<Utc>>,
}

/// Recency multiplier for one commit — newer work counts for more.
fn recency_weight(date: Option<DateTime<Utc>>, now: DateTime<Utc>) -> f64 {
    let Some(d) = date else { return 1.0 };
    match (now - d).num_days().max(0) {
        0..=30 => 4.0,
        31..=90 => 3.0,
        91..=180 => 2.0,
        181..=365 => 1.5,
        _ => 1.0,
    }
}

/// Aggregate commits across all mapped files into ranked author scores
/// (highest first). Commits with neither a login nor a name are ignored.
pub fn rank_authors(commits: &[FileCommit]) -> Vec<AuthorScore> {
    rank_authors_at(commits, Utc::now())
}

/// Testable core: aggregation relative to an explicit "now".
fn rank_authors_at(commits: &[FileCommit], now: DateTime<Utc>) -> Vec<AuthorScore> {
    let mut map: HashMap<String, AuthorScore> = HashMap::new();
    for c in commits {
        // Identity: login when present (authoritative), else the display name.
        let key = match (&c.login, &c.name) {
            (Some(l), _) => format!("login:{}", l.to_ascii_lowercase()),
            (None, Some(n)) => format!("name:{n}"),
            (None, None) => continue,
        };
        let recent = c.date.map(|d| (now - d).num_days() <= 90).unwrap_or(false);
        let weight = recency_weight(c.date, now);
        let entry = map.entry(key).or_insert_with(|| AuthorScore {
            login: c.login.clone(),
            name: c.name.clone(),
            score: 0.0,
            commits: 0,
            recent_commits: 0,
            last_activity: None,
        });
        entry.score += weight;
        entry.commits += 1;
        if recent {
            entry.recent_commits += 1;
        }
        if let Some(d) = c.date {
            entry.last_activity = Some(entry.last_activity.map_or(d, |cur| cur.max(d)));
        }
    }

    let mut scored: Vec<AuthorScore> = map.into_values().collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.commits.cmp(&a.commits))
    });
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(login: &str, days_ago: i64, now: DateTime<Utc>) -> FileCommit {
        FileCommit {
            login: Some(login.to_string()),
            name: Some(login.to_string()),
            date: Some(now - chrono::Duration::days(days_ago)),
        }
    }

    #[test]
    fn ranks_by_recency_weighted_volume() {
        let now = Utc::now();
        // bob: 2 old commits (weight 1 each = 2). alice: 1 very recent (weight 4).
        let commits = vec![
            commit("bob", 400, now),
            commit("bob", 500, now),
            commit("alice", 5, now),
        ];
        let ranked = rank_authors_at(&commits, now);
        assert_eq!(ranked[0].login.as_deref(), Some("alice"));
        assert_eq!(ranked[0].recent_commits, 1);
        assert_eq!(ranked[1].login.as_deref(), Some("bob"));
        assert_eq!(ranked[1].commits, 2);
    }

    #[test]
    fn logins_are_case_insensitive() {
        let now = Utc::now();
        let commits = vec![commit("Alice", 5, now), commit("alice", 10, now)];
        let ranked = rank_authors_at(&commits, now);
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].commits, 2);
    }
}
