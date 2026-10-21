use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use chrono_tz::Tz;
use serde_json::Value;
use sqlx::PgPool;
use thiserror::Error;
use tracing::{instrument, warn};

fn cal_url() -> String {
    crate::external::google_calendar_url()
}

/// The zone an imported event's wall-clock time is stored in. Meetings keep a
/// zone-less date and time that the app reads in the viewer's own zone, so
/// the best match is the calendar's zone (the user's Google Calendar setting,
/// the top-level `timeZone` of the events response), then the event's own
/// `start.timeZone`, then UTC. Never a fixed zone: that put every imported
/// meeting on New York's clock whatever the user's zone.
fn event_zone(calendar_tz: Option<&str>, event_tz: Option<&str>) -> Tz {
    [calendar_tz, event_tz]
        .into_iter()
        .flatten()
        .find_map(|name| name.trim().parse::<Tz>().ok())
        .unwrap_or(Tz::UTC)
}

/// An event's RFC 3339 start/end as the (date, start, end) wall-clock slot the
/// meetings table stores, in `zone`. An event that runs past midnight is
/// clipped to 23:59 on its start day. `None` for unparseable or empty slots.
fn wall_clock_slot(
    start_rfc3339: &str,
    end_rfc3339: &str,
    zone: Tz,
) -> Option<(NaiveDate, NaiveTime, NaiveTime)> {
    let start = DateTime::parse_from_rfc3339(start_rfc3339)
        .ok()?
        .with_timezone(&zone);
    let end = DateTime::parse_from_rfc3339(end_rfc3339)
        .ok()?
        .with_timezone(&zone);
    let date = start.date_naive();
    let start_time = start.time();
    let end_time = if end.date_naive() == date {
        end.time()
    } else {
        NaiveTime::from_hms_opt(23, 59, 0)?
    };
    (end_time > start_time).then_some((date, start_time, end_time))
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

    // The user's calendar zone; see `event_zone`.
    let calendar_tz = body.get("timeZone").and_then(|v| v.as_str());

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

        if ev.get("status").and_then(|v| v.as_str()) == Some("cancelled") {
            continue;
        }

        let title = ev
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("(No title)")
            .to_string();

        // Only timed events; all-day events have no `dateTime` and are skipped.
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

        let event_tz = ev
            .get("start")
            .and_then(|s| s.get("timeZone"))
            .and_then(|v| v.as_str());
        let zone = event_zone(calendar_tz, event_tz);
        let Some((date, start_time, end_time)) = wall_clock_slot(start_str, end_str, zone) else {
            continue;
        };

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

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap_or_else(|| panic!("bad date {y}-{m}-{d}"))
    }

    fn hm(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).unwrap_or_else(|| panic!("bad time {h}:{m}"))
    }

    #[test]
    fn zone_prefers_the_calendar_then_the_event_then_utc() {
        assert_eq!(
            event_zone(Some("Asia/Kolkata"), Some("Europe/London")),
            Tz::Asia__Kolkata
        );
        assert_eq!(
            event_zone(Some("Not/AZone"), Some("Europe/London")),
            Tz::Europe__London
        );
        assert_eq!(event_zone(None, Some("Europe/London")), Tz::Europe__London);
        assert_eq!(event_zone(None, None), Tz::UTC);
        assert_eq!(event_zone(Some(""), Some("nonsense")), Tz::UTC);
    }

    #[test]
    fn a_meeting_keeps_its_wall_clock_in_the_users_zone() {
        // 10:00–11:00 in India. Stored in the user's (India) zone it stays
        // 10:00 on the 21st; the old fixed New York zone turned it into 00:30.
        let (start, end) = ("2026-10-21T10:00:00+05:30", "2026-10-21T11:00:00+05:30");
        assert_eq!(
            wall_clock_slot(start, end, Tz::Asia__Kolkata),
            Some((ymd(2026, 10, 21), hm(10, 0), hm(11, 0)))
        );
        assert_eq!(
            wall_clock_slot(start, end, Tz::America__New_York),
            Some((ymd(2026, 10, 21), hm(0, 30), hm(1, 30)))
        );
    }

    #[test]
    fn a_meeting_past_midnight_is_clipped_and_empty_slots_are_dropped() {
        assert_eq!(
            wall_clock_slot(
                "2026-10-21T23:30:00+05:30",
                "2026-10-22T00:30:00+05:30",
                Tz::Asia__Kolkata
            ),
            Some((ymd(2026, 10, 21), hm(23, 30), hm(23, 59)))
        );
        assert_eq!(
            wall_clock_slot("2026-10-21T10:00:00Z", "2026-10-21T10:00:00Z", Tz::UTC),
            None
        );
        assert_eq!(
            wall_clock_slot("not a time", "2026-10-21T10:00:00Z", Tz::UTC),
            None
        );
    }
}
