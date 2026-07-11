// Platform-owner-only tracing overview. Reads the tail of the JSON-lines
// tracing log (logs/tracing.log — the same stream the tracing layer writes)
// and aggregates it into a small shape the in-app dashboard charts: log
// volume over time by level, level totals, busiest targets, slowest spans,
// and the most recent entries. The file can be tens of MB, so we only read
// the last few MB rather than the whole thing.

use crate::prelude::*;
use chrono::{DateTime, Timelike, Utc};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tracing::instrument;
use wayve_security::rbac::{self, Permission, Role, Scope};

const TRACING_LOG_PATH: &str = "logs/tracing.log";
// How much of the tail to read. ~3 MB is several thousand recent lines —
// plenty for a live "what's happening now" view without loading the archive.
const TAIL_BYTES: u64 = 3_000_000;
const MAX_TIMELINE_BUCKETS: usize = 120;
const TOP_TARGETS: usize = 12;
const SLOWEST_N: usize = 15;
const RECENT_N: usize = 100;

#[derive(Deserialize)]
pub struct TracingQuery {
    pub level: Option<String>,
}

// Read up to `max_bytes` from the end of the file, dropping the first
// (likely partial) line. Missing file → empty string (no events yet).
async fn read_tail(path: &str, max_bytes: u64) -> String {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return String::new();
    };
    let len = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => return String::new(),
    };
    let start = len.saturating_sub(max_bytes);
    if start > 0 && file.seek(SeekFrom::Start(start)).await.is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).await.is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0
        && let Some(pos) = text.find('\n')
    {
        return text[pos + 1..].to_string();
    }
    text
}

// "3.44ms" / "1.2s" / "500µs" / "10ns" → milliseconds.
fn parse_busy_ms(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    // (suffix, multiplier → milliseconds). Longer/more-specific suffixes come
    // first so "ms"/"µs"/"ns" win before the bare "s". "µs" also accepts the
    // ASCII "us" spelling.
    const UNITS: &[(&str, f64)] = &[
        ("ms", 1.0),
        ("µs", 0.001),
        ("us", 0.001),
        ("ns", 0.000_001),
        ("s", 1000.0),
    ];
    for &(suffix, mult) in UNITS {
        if let Some(v) = raw.strip_suffix(suffix) {
            return v.trim().parse::<f64>().ok().map(|n| n * mult);
        }
    }
    None
}

#[derive(Default)]
struct Bucket {
    info: u64,
    warn: u64,
    error: u64,
    debug: u64,
    other: u64,
}

#[get("/platform/tracing-overview")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn tracing_overview(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<TracingQuery>,
) -> AppResult {
    // Platform OWNER only — the rawest operational data in the app.
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::LogsRead).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Platform || ctx.role != Role::Owner {
        return Ok(
            HttpResponse::Forbidden().json(serde_json::json!({ "message": "Platform owner only" }))
        );
    }

    let level_filter = query
        .level
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_uppercase);

    let text = read_tail(TRACING_LOG_PATH, TAIL_BYTES).await;

    let mut total: u64 = 0;
    let mut levels: HashMap<String, u64> = HashMap::new();
    let mut targets: HashMap<String, u64> = HashMap::new();
    let mut buckets: std::collections::BTreeMap<String, Bucket> = std::collections::BTreeMap::new();
    let mut slowest: Vec<serde_json::Value> = Vec::new();
    let mut recent: Vec<serde_json::Value> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        let level = v.get("level").and_then(Value::as_str).unwrap_or("INFO");
        if let Some(f) = &level_filter
            && level != f
        {
            continue;
        }
        let target = v.get("target").and_then(Value::as_str).unwrap_or("");
        let ts = v.get("timestamp").and_then(Value::as_str).unwrap_or("");
        let span = v
            .get("span")
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str);
        let message = v
            .get("fields")
            .and_then(|f| f.get("message"))
            .and_then(Value::as_str);

        total += 1;
        *levels.entry(level.to_string()).or_default() += 1;
        if !target.is_empty() {
            *targets.entry(target.to_string()).or_default() += 1;
        }

        // Per-minute bucket keyed by the truncated timestamp.
        if let Ok(dt) = ts.parse::<DateTime<Utc>>() {
            let key = dt
                .with_second(0)
                .unwrap_or(dt)
                .format("%Y-%m-%dT%H:%M:00Z")
                .to_string();
            let b = buckets.entry(key).or_default();
            match level {
                "INFO" => b.info += 1,
                "WARN" => b.warn += 1,
                "ERROR" => b.error += 1,
                "DEBUG" => b.debug += 1,
                _ => b.other += 1,
            }
        }

        // Span timing for the "slowest" table.
        if let Some(busy) = v
            .get("fields")
            .and_then(|f| f.get("time.busy"))
            .and_then(Value::as_str)
            .and_then(parse_busy_ms)
        {
            slowest.push(serde_json::json!({
                "ts": ts,
                "target": target,
                "span": span,
                "busy_ms": busy,
                "message": message,
            }));
        }

        recent.push(serde_json::json!({
            "ts": ts,
            "level": level,
            "target": target,
            "span": span,
            "message": message,
        }));
    }

    // Timeline: last N minute-buckets, oldest → newest.
    let timeline: Vec<Value> = buckets
        .iter()
        .rev()
        .take(MAX_TIMELINE_BUCKETS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|(t, b)| {
            serde_json::json!({
                "t": t,
                "INFO": b.info,
                "WARN": b.warn,
                "ERROR": b.error,
                "DEBUG": b.debug,
                "other": b.other,
            })
        })
        .collect();

    // Top targets by volume.
    let mut target_rows: Vec<(String, u64)> = targets.into_iter().collect();
    target_rows.sort_by_key(|r| std::cmp::Reverse(r.1));
    let top_targets: Vec<Value> = target_rows
        .into_iter()
        .take(TOP_TARGETS)
        .map(|(target, count)| serde_json::json!({ "target": target, "count": count }))
        .collect();

    // Slowest spans, descending by busy time.
    slowest.sort_by(|a, b| {
        let av = a.get("busy_ms").and_then(Value::as_f64).unwrap_or(0.0);
        let bv = b.get("busy_ms").and_then(Value::as_f64).unwrap_or(0.0);
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });
    slowest.truncate(SLOWEST_N);

    // Most recent entries, newest first.
    let recent_len = recent.len();
    let recent: Vec<Value> = recent
        .into_iter()
        .skip(recent_len.saturating_sub(RECENT_N))
        .rev()
        .collect();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "total": total,
        "levels": levels,
        "timeline": timeline,
        "top_targets": top_targets,
        "slowest": slowest,
        "recent": recent,
    })))
}

/// Register this domain's routes. Called from `routes::routes` (the aggregator).
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(tracing_overview);
}
