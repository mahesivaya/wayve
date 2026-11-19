import XCTest
@testable import Fluxze

@MainActor
final class NotifierTests: XCTestCase {
    func testEachKindIsOnUntilItOrEverythingIsTurnedOff() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "NotifierTests"))
        defaults.removePersistentDomain(forName: "NotifierTests")
        let kinds = [Notifier.mailKey, Notifier.chatKey, Notifier.reviewsKey, Notifier.meetingsKey]
        XCTAssertTrue(kinds.allSatisfy { Notifier.isOn($0, defaults: defaults) })
        defaults.set(false, forKey: Notifier.chatKey)
        XCTAssertFalse(Notifier.isOn(Notifier.chatKey, defaults: defaults))
        XCTAssertTrue(Notifier.isOn(Notifier.mailKey, defaults: defaults))
        // The switch at the top turns all of them off, whatever each one says.
        defaults.set(false, forKey: Notifier.enabledKey)
        XCTAssertFalse(kinds.contains { Notifier.isOn($0, defaults: defaults) })
        XCTAssertFalse(Notifier.isOn(Notifier.enabledKey, defaults: defaults))
    }

    func testOnlyOtherPeoplesNewOpenPullRequestsCount() {
        let repo = GitRepo(fullName: "acme/web", name: "web", owner: .init(login: "acme"))
        func pr(_ number: Int, by author: String, state: String = "open") -> ReviewItem {
            ReviewItem(repo: repo, pr: PullRequest(
                id: number, number: number, title: "PR \(number)",
                htmlUrl: URL(string: "https://github.com/acme/web/pull/\(number)") ?? URL(fileURLWithPath: "/"),
                state: state, draft: false, user: .init(login: author), body: nil,
                createdAt: nil, updatedAt: nil, mergedAt: nil, head: nil, base: nil))
        }
        let items = [pr(1, by: "bo"), pr(2, by: "bo"), pr(3, by: "Ana"), pr(4, by: "cy", state: "closed")]
        let arrived = ReviewsStore.arrived(in: items, since: ["acme/web#1"], login: "ana")
        XCTAssertEqual(arrived.map(\.pr.number), [2])
        XCTAssertEqual(Notifier.reviewContent(items[1]).title, "bo opened a pull request")
        XCTAssertEqual(Notifier.reviewContent(items[1]).body, "PR 2")
    }

    func testChatBannerNamesTheSenderOnly() {
        XCTAssertEqual(Notifier.chatContent(from: "Ana").title, "Ana")
        XCTAssertEqual(Notifier.chatContent(from: "Ana").body, "New message")
        XCTAssertEqual(Notifier.chatContent(from: "  ").title, "Hadal")
        XCTAssertEqual(Notifier.chatContent(from: nil).title, "Hadal")
    }

    func testBadgeCountsMailAndChat() {
        XCTAssertEqual(Notifier.badgeCount(mail: 5, chat: 2, enabled: true), 7)
        XCTAssertEqual(Notifier.badgeCount(mail: 5, chat: 2, enabled: false), 0)
        XCTAssertEqual(Notifier.badgeCount(mail: -1, chat: 2, enabled: true), 2)
    }

    private func email(_ id: Int, read: Bool = false) -> EmailSummary {
        EmailSummary(id: id, accountId: 1, subject: id == 9 ? "  " : "Hello \(id)", sender: "Ana Lopez <ana@x.com>",
                     receiver: nil, isRead: read, isStarred: nil, hasAttachments: nil, createdAt: nil, sortAt: nil)
    }

    func testOnlyMailNewerThanTheLastCheckCounts() {
        let known: Set<Int> = [10, 11, 12]
        // 13 is new; 14 is new but already read; 8 slid onto the page from further down.
        let arrived = EmailsStore.arrived(in: [email(14, read: true), email(13), email(12), email(8)], since: known)
        XCTAssertEqual(arrived.map(\.id), [13])
        // Nothing was known (an empty inbox before): no baseline to compare with.
        XCTAssertEqual(EmailsStore.arrived(in: [email(13)], since: []).map(\.id), [])
    }

    func testMailBannerShowsSenderAndSubject() {
        XCTAssertEqual(Notifier.mailContent(email(13)).title, "Ana Lopez")
        XCTAssertEqual(Notifier.mailContent(email(13)).body, "Hello 13")
        XCTAssertEqual(Notifier.mailContent(email(9)).body, "(no subject)")
    }

    func testMeetingRemindersComeTenMinutesBefore() throws {
        func meeting(_ id: Int, _ date: String, _ time: String, title: String = "Standup") -> Meeting {
            Meeting(id: id, title: title, date: date, startTime: time, endTime: "23:59:00")
        }
        let soon = meeting(1, "2026-11-20", "09:00:00")
        let now = try XCTUnwrap(soon.start).addingTimeInterval(-3600)
        let reminders = Notifier.reminders(for: [
            meeting(2, "2026-11-21", "09:00:00", title: " "), soon,
            meeting(3, "2026-11-19", "09:00:00"),                     // already over
            Meeting(id: 4, title: "Too close", date: "2026-11-20", startTime: "08:05:00", endTime: "09:00:00"),
        ], now: now)
        XCTAssertEqual(reminders.map(\.id), ["meeting-1", "meeting-2"])
        XCTAssertEqual(reminders[0].fireAt, try XCTUnwrap(soon.start).addingTimeInterval(-600))
        XCTAssertEqual(reminders[0].title, "Standup")
        XCTAssertEqual(reminders[1].title, "Meeting")
        XCTAssertTrue(reminders[0].body.hasPrefix("Starts at "))
    }
}
