use chrono::{DateTime, Utc};
use chrono_tz::America::New_York;
use serde_json::Value;
use sqlx::PgPool;
use thiserror::Error;
use tracing::{instrument, warn};

fn cal_url() -> String {
    crate::external::google_calendar_url()
}

#[derive(Debug, Error)]
pub enum CalendarImportError {
    #[error("HTTP client error: {0}")]
    HttpClient(#[source] reqwest::Error),
    #[error("Calendar request failed: {0}")]
    Request(#[source] reqwest::Error),
    #[error("Calendar API error: {0}")]
    ApiStatus(String),
    #[error("Calendar parse error: {0}")]
    Parse(#[source] reqwest::Error),
}

#[instrument(target = "scheduler", skip(pool, access_token))]
pub async fn import_upcoming_events(
    pool: &PgPool,
    user_id: i32,
    account_id: i32,
    access_token: &str,
) -> Result<usize, CalendarImportError> {
    let now = Utc::now();
    let time_min = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let time_max = (now + chrono::Duration::days(60))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(CalendarImportError::HttpClient)?;

    let res = client
        .get(cal_url())
        .bearer_auth(access_token)
        .query(&[
            ("timeMin", time_min.as_str()),
            ("timeMax", time_max.as_str()),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", "250"),
        ])
        .send()
        .await
        .map_err(CalendarImportError::Request)?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(CalendarImportError::ApiStatus(text));
    }

    let body: Value = res.json().await.map_err(CalendarImportError::Parse)?;

    let items = body
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut inserted = 0usize;

    for ev in items {
        let event_id = match ev.get("id").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Skip cancelled events.
        if ev.get("status").and_then(|v| v.as_str()) == Some("cancelled") {
            continue;
        }

        let title = ev
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("(No title)")
            .to_string();

        // Only timed events (skip all-day for now).
        let start_str = ev
            .get("start")
            .and_then(|s| s.get("dateTime"))
            .and_then(|v| v.as_str());
        let end_str = ev
            .get("end")
            .and_then(|e| e.get("dateTime"))
            .and_then(|v| v.as_str());

        let (Some(start_str), Some(end_str)) = (start_str, end_str) else {
            continue;
        };

        let start_dt = match DateTime::parse_from_rfc3339(start_str) {
            Ok(d) => d.with_timezone(&New_York),
            Err(_) => continue,
        };
        let end_dt = match DateTime::parse_from_rfc3339(end_str) {
            Ok(d) => d.with_timezone(&New_York),
            Err(_) => continue,
        };

        let date = start_dt.date_naive();
        let start_time = start_dt.time();
        // Clip end to same day if event spans midnight, so it fits the
        // (date, start_time, end_time) shape the table expects.
        let end_time = if end_dt.date_naive() == date {
            end_dt.time()
        } else {
            chrono::NaiveTime::from_hms_opt(23, 59, 0).expect("23:59:00 is a valid time")
        };

        if end_time <= start_time {
            continue;
        }

        let join_url = ev
            .get("hangoutLink")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let res = sqlx::query(
            r#"
            INSERT INTO meetings
              (title, date, start_time, end_time, user_id, source, google_event_id, account_id, zoom_join_url)
            VALUES ($1, $2, $3, $4, $5, 'google', $6, $7, $8)
            ON CONFLICT (user_id, google_event_id) WHERE google_event_id IS NOT NULL
            DO UPDATE SET
              title = EXCLUDED.title,
              date = EXCLUDED.date,
              start_time = EXCLUDED.start_time,
              end_time = EXCLUDED.end_time,
              zoom_join_url = EXCLUDED.zoom_join_url
            "#,
        )
        .bind(&title)
        .bind(date)
        .bind(start_time)
        .bind(end_time)
        .bind(user_id)
        .bind(&event_id)
        .bind(account_id)
        .bind(&join_url)
        .execute(pool)
        .await;

        match res {
            Ok(_) => inserted += 1,
            Err(e) => warn!(target: "db", %event_id, error = ?e, "calendar event insert failed"),
        }
    }

    Ok(inserted)
}
