import Foundation

/// Parses the backend's timestamps. Task timestamps are Postgres `TIMESTAMP`
/// columns serialized without an offset ("2026-11-10T12:34:56.123456", 0–9
/// fractional digits) and are written with the database's UTC clock, so a
/// missing offset means UTC. Values that do carry `Z` or `±HH:MM` are honoured.
enum ServerDate {
    private static let pattern = try! NSRegularExpression(
        pattern: #"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$"#
    )

    private static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }()

    static func parse(_ text: String) -> Date? {
        let range = NSRange(text.startIndex..., in: text)
        guard let match = pattern.firstMatch(in: text, range: range) else { return nil }

        func group(_ index: Int) -> String? {
            guard let r = Range(match.range(at: index), in: text) else { return nil }
            return String(text[r])
        }
        func int(_ index: Int) -> Int? { group(index).flatMap { Int($0) } }

        var components = DateComponents()
        components.year = int(1)
        components.month = int(2)
        components.day = int(3)
        components.hour = int(4)
        components.minute = int(5)
        components.second = int(6)
        guard let whole = utcCalendar.date(from: components) else { return nil }

        var fraction = 0.0
        if let digits = group(7) {
            fraction = Double("0." + digits) ?? 0
        }

        var offsetSeconds = 0
        if let zone = group(8), zone != "Z" {
            let sign = zone.hasPrefix("-") ? -1 : 1
            let digits = zone.dropFirst().replacingOccurrences(of: ":", with: "")
            let hours = Int(digits.prefix(2)) ?? 0
            let minutes = Int(digits.suffix(2)) ?? 0
            offsetSeconds = sign * (hours * 3600 + minutes * 60)
        }

        return whole.addingTimeInterval(fraction - Double(offsetSeconds))
    }
}
