import XCTest
@testable import Fluxze

@MainActor
final class MeetingModelTests: XCTestCase {
    private let tz = TimeZone(identifier: "America/New_York")!

    func testDecodesServerList() throws {
        let json = """
        [{"id":4,"title":"Standup","date":"2026-11-12","start_time":"09:30:00","end_time":"10:00:00",
          "participants":["a@b.com"],"zoom_join_url":"https://zoom.us/j/1","source":"wayve"},
         {"id":5,"title":"Holiday","date":"2026-11-26","start_time":"00:00:00","end_time":"23:59:00",
          "participants":[],"zoom_join_url":null,"source":"google"}]
        """
        let meetings = try APIClient.decoder.decode([Meeting].self, from: Data(json.utf8))
        XCTAssertEqual(meetings.count, 2)
        XCTAssertEqual(meetings[0].startMinutes, 9 * 60 + 30)
        XCTAssertEqual(meetings[0].endMinutes, 10 * 60)
        XCTAssertEqual(meetings[0].joinURL, URL(string: "https://zoom.us/j/1"))
        XCTAssertFalse(meetings[0].isFromGoogle)
        XCTAssertTrue(meetings[1].isFromGoogle)
        XCTAssertNil(meetings[1].joinURL)
    }

    func testWallClockRoundTrip() throws {
        let day = try XCTUnwrap(WallClock.day("2026-03-08", timeZone: tz))
        XCTAssertEqual(WallClock.string(day: day, timeZone: tz), "2026-03-08")
        // The DST change day: 9:00 is still 9:00 local.
        let nine = try XCTUnwrap(WallClock.date(day: "2026-03-08", time: "09:00", timeZone: tz))
        XCTAssertEqual(WallClock.minutes(of: nine, timeZone: tz), 9 * 60)
    }

    func testMinutesParsing() {
        XCTAssertEqual(WallClock.minutes("00:00:00"), 0)
        XCTAssertEqual(WallClock.minutes("23:59"), 23 * 60 + 59)
        XCTAssertNil(WallClock.minutes("24:00"))
        XCTAssertNil(WallClock.minutes("noon"))
    }

    func testInputEncodesServerShape() throws {
        let day = try XCTUnwrap(WallClock.day("2026-11-12", timeZone: tz))
        let input = MeetingInput(title: "Plan", day: day, start: 600, end: 630,
                                 participants: ["x@y.io"], timeZone: tz)
        let data = try APIClient.encoder.encode(input)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["date"] as? String, "2026-11-12")
        XCTAssertEqual(object["start"] as? Int, 600)
        XCTAssertEqual(object["end"] as? Int, 630)
        XCTAssertEqual(object["tz"] as? String, "America/New_York")
        XCTAssertEqual(object["participants"] as? [String], ["x@y.io"])
    }

    func testParticipantParsing() {
        XCTAssertEqual(
            MeetingInput.parseParticipants(" A@b.com, c@d.org;\nnot-an-email  e@f.net "),
            ["a@b.com", "c@d.org", "e@f.net"]
        )
        XCTAssertEqual(MeetingInput.parseParticipants(""), [])
    }

    func testMeetingsOnDaySortedByStart() throws {
        let store = MeetingsStore(api: APIClient(baseURL: URL(string: "http://test.local")!))
        let json = """
        [{"id":2,"title":"Late","date":"2026-11-12","start_time":"15:00:00","end_time":"16:00:00","source":"wayve"},
         {"id":1,"title":"Early","date":"2026-11-12","start_time":"08:00:00","end_time":"09:00:00","source":"wayve"},
         {"id":3,"title":"Other day","date":"2026-11-13","start_time":"08:00:00","end_time":"09:00:00","source":"wayve"}]
        """
        let meetings = try APIClient.decoder.decode([Meeting].self, from: Data(json.utf8))
        store.replaceForTesting(meetings)
        let day = try XCTUnwrap(WallClock.day("2026-11-12", timeZone: tz))
        XCTAssertEqual(store.meetings(on: day, timeZone: tz).map(\.title), ["Early", "Late"])
    }
}
