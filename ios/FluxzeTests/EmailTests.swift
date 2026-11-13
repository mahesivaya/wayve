import XCTest
@testable import Fluxze

@MainActor
final class EmailTests: XCTestCase {
    func testDecodesAnInboxRow() throws {
        let json = """
        [{"id": 42, "gmail_id": "abc", "account_id": 7, "subject": "Hello",
          "sender": "Ayana Rao <ayana@example.com>", "receiver": "me@example.com",
          "has_body": true, "has_attachments": true, "is_read": false, "is_starred": true,
          "is_invite": false, "created_at": "2026-11-13T09:30:00+00:00",
          "sort_at": "2026-11-13T09:30:00.250+00:00", "is_shared": false}]
        """
        let rows = try APIClient.decoder.decode([EmailSummary].self, from: Data(json.utf8))
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.id, 42)
        XCTAssertEqual(row.accountId, 7)
        XCTAssertFalse(row.isRead)
        XCTAssertEqual(row.hasAttachments, true)
        XCTAssertEqual(row.listDate?.timeIntervalSince1970 ?? 0, 1_794_562_200.25, accuracy: 0.001)
    }

    func testListPathForInboxSearchAndPaging() throws {
        XCTAssertEqual(EmailsStore.listPath(folder: .inbox, accountID: nil, query: "", before: nil),
                       "/api/emails?folder=inbox")
        XCTAssertEqual(EmailsStore.listPath(folder: .sent, accountID: nil, query: "", before: nil),
                       "/api/emails?folder=sent")
        XCTAssertEqual(EmailsStore.listPath(folder: .important, accountID: nil, query: "", before: nil),
                       "/api/emails?folder=important")
        XCTAssertEqual(EmailsStore.listPath(folder: .sent, accountID: 3, query: "invoice may", before: nil),
                       "/api/emails?folder=all&account_id=3&q=invoice%20may")

        let last = EmailSummary(
            id: 9, accountId: 1, subject: nil, sender: nil, receiver: nil, isRead: true,
            isStarred: nil, hasAttachments: nil, createdAt: nil,
            sortAt: Date(timeIntervalSince1970: 1_794_562_200.25))
        XCTAssertEqual(EmailsStore.listPath(folder: .inbox, accountID: nil, query: "", before: last),
                       "/api/emails?folder=inbox&before=1794562200250&before_id=9")
    }

    func testSenderNamesAndAddresses() {
        XCTAssertEqual(EmailText.name(of: "Ayana Rao <ayana@example.com>"), "Ayana Rao")
        XCTAssertEqual(EmailText.name(of: "\"Rao, Ayana\" <ayana@example.com>"), "Rao, Ayana")
        XCTAssertEqual(EmailText.name(of: "<ayana@example.com>"), "ayana@example.com")
        XCTAssertEqual(EmailText.name(of: "ayana@example.com"), "ayana@example.com")
        XCTAssertEqual(EmailText.name(of: nil), "Unknown sender")
        XCTAssertEqual(EmailText.address(of: "Ayana <ayana@example.com>"), "ayana@example.com")
    }

    /// Against a running dev stack, as a user who has mail. Skipped unless
    ///   TEST_RUNNER_FLUXZE_LIVE_URL=http://localhost TEST_RUNNER_FLUXZE_LIVE_TOKEN=<jwt>
    /// Read-only: lists two pages and opens one body, marks nothing read.
    func testLiveInboxAgainstDevStack() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let base = env["FLUXZE_LIVE_URL"].flatMap(URL.init(string:)),
              let token = env["FLUXZE_LIVE_TOKEN"] else {
            throw XCTSkip("FLUXZE_LIVE_URL / FLUXZE_LIVE_TOKEN not set")
        }
        let store = EmailsStore(api: APIClient(baseURL: base, token: token))
        await store.load()
        XCTAssertNil(store.errorMessage)
        XCTAssertFalse(store.accounts.isEmpty)
        XCTAssertEqual(store.emails.count, EmailsStore.pageSize)

        let firstPage = store.emails.map(\.id)
        await store.loadMore()
        XCTAssertNil(store.errorMessage)
        XCTAssertGreaterThan(store.emails.count, firstPage.count)
        XCTAssertEqual(Set(store.emails.map(\.id)).count, store.emails.count, "no duplicates across pages")
        // Newest first across the page boundary.
        let dates = store.emails.compactMap(\.listDate)
        XCTAssertEqual(dates, dates.sorted(by: >))

        let email = try XCTUnwrap(store.emails.first)
        let body = try await store.body(of: email)
        if let body { XCTAssertFalse(EmailText.isSealed(body)) }
        print("LIVE: \(store.accounts.count) mailbox(es), \(store.emails.count) emails, first body \(body.map { "\($0.count) chars, html=\(EmailText.isHTML($0))" } ?? "sealed")")
    }

    func testSealedAndHTMLDetection() {
        XCTAssertTrue(EmailText.isSealed("WAYVE_SECURE_V1\n{...}"))
        XCTAssertTrue(EmailText.isSealed("WAYVE_CHAT_E2E_V1\n{...}"))
        XCTAssertFalse(EmailText.isSealed("Hi there"))
        XCTAssertTrue(EmailText.isHTML("<div>Hi</div>"))
        XCTAssertTrue(EmailText.isHTML("<P class=x>Hi"))
        XCTAssertFalse(EmailText.isHTML("a < b and c > d"))
    }
}
