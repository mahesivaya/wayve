import Foundation

/// A meeting as returned by `GET /api/meetings` (backend `models/scheduler.rs`).
/// `date` ("YYYY-MM-DD") and the times ("HH:MM:SS") are wall-clock values with
/// no stored zone, read in the device's zone, the same as the web calendar.
struct Meeting: Codable, Identifiable, Hashable {
    let id: Int
    var title: String
    var date: String
    var startTime: String
    var endTime: String
    var participants: [String]?
    var zoomJoinUrl: String?
    /// "wayve" for meetings made in Fluxze, "google" for Google Calendar imports.
    var source: String?

    var start: Date? { WallClock.date(day: date, time: startTime) }
    var end: Date? { WallClock.date(day: date, time: endTime) }
    var day: Date? { WallClock.day(date) }
    var startMinutes: Int { WallClock.minutes(startTime) ?? 0 }
    var endMinutes: Int { WallClock.minutes(endTime) ?? 0 }
    var isFromGoogle: Bool { source == "google" }
    var joinURL: URL? { zoomJoinUrl.flatMap { $0.isEmpty ? nil : URL(string: $0) } }
}

/// Body of `POST /api/meetings` and `PUT /api/meetings/{id}`. `start` and `end`
/// are minutes after midnight on `date`; `tz` lets the server tell whether a
/// new meeting is in the past.
struct MeetingInput: Encodable, Equatable {
    var title: String
    var date: String
    var start: Int
    var end: Int
    var participants: [String]
    var tz: String

    init(title: String, day: Date, start: Int, end: Int, participants: [String],
         timeZone: TimeZone = .current) {
        self.title = title
        self.date = WallClock.string(day: day, timeZone: timeZone)
        self.start = start
        self.end = end
        self.participants = participants
        self.tz = timeZone.identifier
    }

    /// Splits typed text into addresses (comma, space, semicolon or new line).
    /// The server also drops anything that isn't an address.
    static func parseParticipants(_ text: String) -> [String] {
        text.split(whereSeparator: { ",; \n\t".contains($0) })
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { $0.contains("@") && $0.contains(".") }
    }
}

/// Converts between the server's naive "YYYY-MM-DD" / "HH:MM[:SS]" strings and
/// `Date`s in a time zone (the device's by default).
enum WallClock {
    static func calendar(_ timeZone: TimeZone = .current) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    static func day(_ text: String, timeZone: TimeZone = .current) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar(timeZone).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// Minutes after midnight for "HH:MM" or "HH:MM:SS".
    static func minutes(_ text: String) -> Int? {
        let parts = text.split(separator: ":").compactMap { Int($0) }
        guard parts.count >= 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else { return nil }
        return parts[0] * 60 + parts[1]
    }

    static func date(day text: String, time: String, timeZone: TimeZone = .current) -> Date? {
        guard let day = day(text, timeZone: timeZone), let mins = minutes(time) else { return nil }
        return date(day, minutes: mins, timeZone: timeZone)
    }

    static func string(day: Date, timeZone: TimeZone = .current) -> String {
        let c = calendar(timeZone).dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Minutes after midnight of a `Date`'s time of day.
    static func minutes(of date: Date, timeZone: TimeZone = .current) -> Int {
        let c = calendar(timeZone).dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    /// `day` at the wall-clock time `minutes` after midnight. Sets the hour and
    /// minute rather than adding minutes, so a daylight-saving change that day
    /// doesn't shift the time by an hour.
    static func date(_ day: Date, minutes: Int, timeZone: TimeZone = .current) -> Date {
        let cal = calendar(timeZone)
        var c = cal.dateComponents([.year, .month, .day], from: day)
        c.hour = minutes / 60
        c.minute = minutes % 60
        return cal.date(from: c) ?? day
    }
}
