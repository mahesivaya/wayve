//! Reads a meeting invitation: the `text/calendar` part (iCalendar, RFC 5545)
//! every calendar app attaches to an invite. Only what the invite card shows:
//! the calendar's METHOD and the first event's title, time, location, video
//! link, organizer and status. Not a general iCalendar library: recurrence,
//! alarms and attendees are left alone.

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::Serialize;

/// What the invite card shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Invite {
    /// `request` (an invitation or an update), `cancel`, `reply` (someone
    /// accepted or declined), or another METHOD lowercased.
    pub method: Option<String>,
    pub title: Option<String>,
    /// The start and end as exact moments, when the time zone is known.
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    /// A whole-day event: dates, no times.
    pub all_day: bool,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    /// A time in a zone this reader doesn't know: shown as written, with the
    /// zone's name, rather than guessed.
    pub start_local: Option<NaiveDateTime>,
    pub end_local: Option<NaiveDateTime>,
    pub time_zone: Option<String>,
    pub location: Option<String>,
    /// A Meet / Zoom / Teams / Webex link, when the invite has one.
    pub join_url: Option<String>,
    pub organizer_name: Option<String>,
    pub organizer_email: Option<String>,
    /// `confirmed`, `tentative` or `cancelled`, lowercased.
    pub status: Option<String>,
}

/// One content line: `NAME;PARAM=V;PARAM2="V":VALUE`.
struct Line {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Line {
    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Lines longer than 75 octets are folded: a line starting with a space or a
/// tab continues the one before it.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = raw.strip_prefix([' ', '\t'])
            && let Some(last) = lines.last_mut()
        {
            last.push_str(rest);
            continue;
        }
        lines.push(raw.to_string());
    }
    lines
}

/// Splits a line at its first `:` outside double quotes (a quoted parameter,
/// like `CN="Doe: Jane"`, may contain one).
fn parse_line(line: &str) -> Option<Line> {
    let mut in_quotes = false;
    let colon = line.char_indices().find_map(|(i, c)| match c {
        '"' => {
            in_quotes = !in_quotes;
            None
        }
        ':' if !in_quotes => Some(i),
        _ => None,
    })?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = split_unquoted(head, ';').into_iter();
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((
                k.trim().to_ascii_uppercase(),
                v.trim().trim_matches('"').to_string(),
            ))
        })
        .collect();
    Some(Line {
        name,
        params,
        value: value.to_string(),
    })
}

fn split_unquoted(s: &str, sep: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for c in s.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                current.push(c);
            }
            c if c == sep && !in_quotes => out.push(std::mem::take(&mut current)),
            c => current.push(c),
        }
    }
    out.push(current);
    out
}

/// TEXT values escape `\\`, `\;`, `\,` and newlines (`\n`).
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out.trim().to_string()
}

/// A few Windows time-zone names Outlook and Exchange write as TZID, mapped to
/// the IANA names `chrono_tz` knows. Anything else is shown as written.
pub(crate) fn windows_zone(name: &str) -> Option<&'static str> {
    Some(match name {
        "Eastern Standard Time" | "US Eastern Standard Time" => "America/New_York",
        "Central Standard Time" => "America/Chicago",
        "Mountain Standard Time" => "America/Denver",
        "US Mountain Standard Time" => "America/Phoenix",
        "Pacific Standard Time" => "America/Los_Angeles",
        "Alaskan Standard Time" => "America/Anchorage",
        "Hawaiian Standard Time" => "Pacific/Honolulu",
        "GMT Standard Time" => "Europe/London",
        "Greenwich Standard Time" | "UTC" | "Coordinated Universal Time" => "UTC",
        "W. Europe Standard Time" => "Europe/Berlin",
        "Romance Standard Time" => "Europe/Paris",
        "Central Europe Standard Time" => "Europe/Budapest",
        "Central European Standard Time" => "Europe/Warsaw",
        "E. Europe Standard Time" => "Europe/Chisinau",
        "FLE Standard Time" => "Europe/Kiev",
        "India Standard Time" => "Asia/Kolkata",
        "China Standard Time" => "Asia/Shanghai",
        "Tokyo Standard Time" => "Asia/Tokyo",
        "Singapore Standard Time" => "Asia/Singapore",
        "AUS Eastern Standard Time" => "Australia/Sydney",
        "Arabian Standard Time" => "Asia/Dubai",
        _ => return None,
    })
}

/// A DATE-TIME or DATE property. Returns (exact moment, all-day date, wall
/// time in an unknown zone).
fn parse_when(
    line: &Line,
) -> (
    Option<DateTime<Utc>>,
    Option<NaiveDate>,
    Option<NaiveDateTime>,
) {
    let value = line.value.trim();
    if line
        .param("VALUE")
        .is_some_and(|v| v.eq_ignore_ascii_case("DATE"))
        || value.len() == 8
    {
        return (None, NaiveDate::parse_from_str(value, "%Y%m%d").ok(), None);
    }
    if let Some(utc) = value.strip_suffix('Z') {
        let moment = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S")
            .ok()
            .map(|t| Utc.from_utc_datetime(&t));
        return (moment, None, None);
    }
    let Ok(local) = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S") else {
        return (None, None, None);
    };
    let zone = line.param("TZID").map(|z| z.trim_start_matches('/'));
    let tz = zone.and_then(|z| {
        z.parse::<chrono_tz::Tz>()
            .ok()
            .or_else(|| windows_zone(z).and_then(|iana| iana.parse().ok()))
    });
    match tz {
        // `earliest` settles the hour a clock change repeats or skips.
        Some(tz) => (
            tz.from_local_datetime(&local)
                .earliest()
                .map(|t| t.with_timezone(&Utc)),
            None,
            None,
        ),
        None => (None, None, Some(local)),
    }
}

/// The first https link to a known video-call service in `text`.
pub(crate) fn video_link(text: &str) -> Option<String> {
    const SERVICES: [&str; 5] = [
        "meet.google.com",
        "zoom.us",
        "teams.microsoft.com",
        "teams.live.com",
        "webex.com",
    ];
    text.split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '(' | ')'))
        .filter(|word| word.starts_with("https://"))
        .map(|word| word.trim_end_matches(['.', ',', ';']))
        .find(|url| SERVICES.iter().any(|s| url.contains(s)))
        .map(str::to_string)
}

/// Reads an invitation from a `text/calendar` body. `None` when it has no
/// event.
pub fn parse_invite(text: &str) -> Option<Invite> {
    let mut invite = Invite::default();
    let mut in_event = false;
    let mut seen_event = false;
    let mut nested = 0usize;
    let mut description = String::new();
    let mut conference: Option<String> = None;
    let mut url: Option<String> = None;

    for raw in unfold(text) {
        let Some(line) = parse_line(&raw) else {
            continue;
        };
        match line.name.as_str() {
            "BEGIN" if line.value.eq_ignore_ascii_case("VEVENT") && !seen_event => {
                in_event = true;
            }
            // VALARM and the like sit inside a VEVENT; their lines aren't the event's.
            "BEGIN" if in_event => nested += 1,
            "END" if in_event && nested > 0 => nested -= 1,
            "END" if in_event && line.value.eq_ignore_ascii_case("VEVENT") => {
                in_event = false;
                seen_event = true;
            }
            "METHOD" if !in_event => {
                invite.method = Some(line.value.trim().to_ascii_lowercase());
            }
            _ if !in_event || nested > 0 => {}
            "SUMMARY" => invite.title = Some(unescape(&line.value)).filter(|s| !s.is_empty()),
            "LOCATION" => {
                invite.location = Some(unescape(&line.value)).filter(|s| !s.is_empty());
            }
            "DESCRIPTION" => description = unescape(&line.value),
            "STATUS" => invite.status = Some(line.value.trim().to_ascii_lowercase()),
            "URL" => url = Some(line.value.trim().to_string()),
            "X-GOOGLE-CONFERENCE" | "X-MICROSOFT-SKYPETEAMSMEETINGURL" => {
                conference = Some(line.value.trim().to_string());
            }
            "ORGANIZER" => {
                invite.organizer_name = line.param("CN").map(str::to_string);
                let address = line.value.trim();
                let address = address
                    .strip_prefix("mailto:")
                    .or_else(|| address.strip_prefix("MAILTO:"))
                    .unwrap_or(address);
                invite.organizer_email = Some(address.to_string()).filter(|a| a.contains('@'));
            }
            "DTSTART" | "DTEND" => {
                let (moment, date, local) = parse_when(&line);
                let is_start = line.name == "DTSTART";
                if date.is_some() {
                    invite.all_day = true;
                }
                if local.is_some() {
                    invite.time_zone = line.param("TZID").map(str::to_string);
                }
                if is_start {
                    (invite.start, invite.start_date, invite.start_local) = (moment, date, local);
                } else {
                    (invite.end, invite.end_date, invite.end_local) = (moment, date, local);
                }
            }
            _ => {}
        }
    }
    if !seen_event && !in_event {
        return None;
    }
    invite.join_url = conference
        .or_else(|| url.filter(|u| video_link(u).is_some()))
        .or_else(|| invite.location.as_deref().and_then(video_link))
        .or_else(|| video_link(&description));
    Some(invite)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOGLE: &str = "BEGIN:VCALENDAR\r\n\
PRODID:-//Google Inc//Google Calendar 70.9054//EN\r\n\
VERSION:2.0\r\n\
METHOD:REQUEST\r\n\
BEGIN:VEVENT\r\n\
DTSTART;TZID=America/New_York:20261020T150000\r\n\
DTEND;TZID=America/New_York:20261020T153000\r\n\
ORGANIZER;CN=\"Doe: Ada\":mailto:ada@x.com\r\n\
SUMMARY:Quarterly review\\, part 2\r\n\
LOCATION:Room 4\r\n\
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij\r\n\
DESCRIPTION:Agenda:\\nNumbers and a very long line that the sender folded so th\r\n\
 at it stays under seventy-five octets\r\n\
STATUS:CONFIRMED\r\n\
BEGIN:VALARM\r\n\
ACTION:DISPLAY\r\n\
DESCRIPTION:Reminder\r\n\
END:VALARM\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

    #[test]
    fn reads_a_google_invitation() {
        let invite = parse_invite(GOOGLE).unwrap_or_else(|| panic!("no invite"));
        assert_eq!(invite.method.as_deref(), Some("request"));
        assert_eq!(invite.title.as_deref(), Some("Quarterly review, part 2"));
        // 3 PM in New York in October (EDT, UTC-4) is 19:00 UTC.
        assert_eq!(
            invite.start.map(|t| t.to_rfc3339()),
            Some("2026-10-20T19:00:00+00:00".to_string())
        );
        assert_eq!(
            invite.end.map(|t| t.to_rfc3339()),
            Some("2026-10-20T19:30:00+00:00".to_string())
        );
        assert!(!invite.all_day);
        assert_eq!(invite.location.as_deref(), Some("Room 4"));
        assert_eq!(
            invite.join_url.as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
        // A quoted parameter may contain the line's separator.
        assert_eq!(invite.organizer_name.as_deref(), Some("Doe: Ada"));
        assert_eq!(invite.organizer_email.as_deref(), Some("ada@x.com"));
        assert_eq!(invite.status.as_deref(), Some("confirmed"));
    }

    #[test]
    fn reads_utc_times_all_day_events_and_cancellations() {
        let utc = "BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nDTSTART:20261020T150000Z\n\
DTEND:20261020T160000Z\nSUMMARY:Standup\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR\n";
        let invite = parse_invite(utc).unwrap_or_else(|| panic!("no invite"));
        assert_eq!(invite.method.as_deref(), Some("cancel"));
        assert_eq!(invite.status.as_deref(), Some("cancelled"));
        assert_eq!(
            invite.start.map(|t| t.to_rfc3339()),
            Some("2026-10-20T15:00:00+00:00".to_string())
        );

        let all_day = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261024\n\
DTEND;VALUE=DATE:20261025\nSUMMARY:Offsite\nEND:VEVENT\nEND:VCALENDAR\n";
        let invite = parse_invite(all_day).unwrap_or_else(|| panic!("no invite"));
        assert!(invite.all_day);
        assert_eq!(
            invite.start_date.map(|d| d.to_string()),
            Some("2026-10-24".into())
        );
        assert_eq!(invite.start, None);
    }

    #[test]
    fn maps_outlooks_windows_zones_and_keeps_unknown_ones_as_written() {
        let outlook = "BEGIN:VCALENDAR\nMETHOD:REQUEST\nBEGIN:VEVENT\n\
DTSTART;TZID=India Standard Time:20261020T100000\nSUMMARY:Sync\n\
DESCRIPTION:Join: https://teams.microsoft.com/l/meetup-join/19%3a; thanks.\nEND:VEVENT\nEND:VCALENDAR\n";
        let invite = parse_invite(outlook).unwrap_or_else(|| panic!("no invite"));
        // 10:00 in India (UTC+5:30) is 04:30 UTC.
        assert_eq!(
            invite.start.map(|t| t.to_rfc3339()),
            Some("2026-10-20T04:30:00+00:00".to_string())
        );
        // The video link is found in the description.
        assert_eq!(
            invite.join_url.as_deref(),
            Some("https://teams.microsoft.com/l/meetup-join/19%3a")
        );

        let unknown = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=Somewhere Odd:20261020T100000\n\
END:VEVENT\nEND:VCALENDAR\n";
        let invite = parse_invite(unknown).unwrap_or_else(|| panic!("no invite"));
        assert_eq!(invite.start, None);
        assert_eq!(
            invite.start_local.map(|t| t.to_string()),
            Some("2026-10-20 10:00:00".to_string())
        );
        assert_eq!(invite.time_zone.as_deref(), Some("Somewhere Odd"));
    }

    #[test]
    fn a_calendar_without_an_event_is_not_an_invite() {
        assert_eq!(
            parse_invite("BEGIN:VCALENDAR\nMETHOD:PUBLISH\nEND:VCALENDAR\n"),
            None
        );
        assert_eq!(parse_invite("not a calendar at all"), None);
    }
}
