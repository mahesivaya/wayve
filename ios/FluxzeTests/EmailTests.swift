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

    func testRecipientSummaryShowsAddresses() {
        XCTAssertEqual(EmailsStore.recipientSummary("Mahesh <mahesh@fluxze.com>"), "to: mahesh@fluxze.com")
        XCTAssertEqual(
            EmailsStore.recipientSummary("\"Rao, Ayana\" <a@x.com>, mahesh@fluxze.com"),
            "to: a@x.com, mahesh@fluxze.com")
        XCTAssertEqual(
            EmailsStore.recipientSummary("a@x.com, b@x.com, c@x.com, d@x.com"),
            "to: a@x.com, b@x.com +2")
        XCTAssertEqual(EmailsStore.recipientSummary(nil), "to: (no recipient)")
    }

    func testPlainTextFromHTML() {
        let html = "<html><head><style>p{}</style></head><body><p>Hi Ana,</p><p>Line&nbsp;one<br>Line two &amp; more</p><ul><li>a</li><li>b</li></ul></body></html>"
        XCTAssertEqual(EmailText.plainText(html), "Hi Ana,\nLine one\nLine two & more\n• a\n• b")
        XCTAssertEqual(EmailText.plainText("  plain\ntext \n"), "plain\ntext")
    }

    func testReplyAndForwardBodies() {
        let original = EmailSummary(
            id: 1, accountId: 2, subject: "Lunch?", sender: "Ana <ana@x.com>", receiver: "me@x.com",
            isRead: true, isStarred: nil, hasAttachments: nil,
            createdAt: Date(timeIntervalSince1970: 0), sortAt: nil)
        XCTAssertEqual(ComposeView.prefixed("Lunch?", "Re:"), "Re: Lunch?")
        XCTAssertEqual(ComposeView.prefixed("RE: Lunch?", "Re:"), "RE: Lunch?")

        let reply = ComposeView.outgoingBody("Sure!", mode: .reply, original: original, originalText: "Noon?\nOr 1?")
        XCTAssertTrue(reply.hasPrefix("Sure!\n\nOn "))
        XCTAssertTrue(reply.hasSuffix("Ana <ana@x.com> wrote:\n> Noon?\n> Or 1?"))

        let forward = ComposeView.outgoingBody("FYI", mode: .forward, original: original, originalText: "Noon?")
        XCTAssertTrue(forward.contains("---------- Forwarded message ---------\nFrom: Ana <ana@x.com>"))
        XCTAssertTrue(forward.hasSuffix("Noon?"))

        XCTAssertEqual(ComposeView.outgoingBody("Hi", mode: .reply, original: original, originalText: nil), "Hi")
    }

    func testOutgoingEncodesTheServerFieldNames() throws {
        let message = EmailsStore.Outgoing(accountId: 2, to: "a@x.com", cc: ["b@x.com"], subject: "S",
                                           body: "B", replyToEmailId: 9, forwardAttachmentIds: nil)
        let json = try JSONSerialization.jsonObject(with: APIClient.encoder.encode(message)) as? [String: Any]
        XCTAssertEqual(json?["account_id"] as? Int, 2)
        XCTAssertEqual(json?["reply_to_email_id"] as? Int, 9)
        XCTAssertEqual(json?["cc"] as? [String], ["b@x.com"])
        XCTAssertNil(json?["forward_attachment_ids"])
    }

    func testSnoozeOptions() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        // Wednesday 2026-11-11 10:00 New York.
        let wednesday = calendar.date(from: DateComponents(year: 2026, month: 11, day: 11, hour: 10))!
        let options = EmailsStore.snoozeOptions(now: wednesday, calendar: calendar)
        XCTAssertEqual(options.map(\.title), ["Later today", "Tomorrow", "This weekend", "Next week"])
        let parts = options.map { calendar.dateComponents([.day, .hour], from: $0.date) }
        XCTAssertEqual(parts.map(\.day), [11, 12, 14, 16])
        XCTAssertEqual(parts.map(\.hour), [18, 8, 8, 8])

        // Saturday evening: no "later today" or "this weekend".
        let saturday = calendar.date(from: DateComponents(year: 2026, month: 11, day: 14, hour: 19))!
        XCTAssertEqual(EmailsStore.snoozeOptions(now: saturday, calendar: calendar).map(\.title), ["Tomorrow", "Next week"])
    }

    func testLabelsDecodeAndListByFolderKey() throws {
        let sidebar = try APIClient.decoder.decode(MailSidebar.self, from: Data("""
        {"counts": {"inbox": 3}, "labels": [{"account_id": 4, "account_email": "me@x.com",
          "label_id": "Label_9", "name": "Clients/Acme", "color": "#16a766", "unread": 2}]}
        """.utf8))
        let label = try XCTUnwrap(sidebar.labels.first)
        XCTAssertEqual(label.name, "Clients/Acme")
        XCTAssertEqual(label.folderKey, "label:4:Label_9")
        XCTAssertEqual(EmailsStore.listPath(folder: .inbox, label: label, accountID: nil, query: "", before: nil),
                       "/api/emails?folder=label:4:Label_9")
        // A search still covers all mail.
        XCTAssertEqual(EmailsStore.listPath(folder: .inbox, label: label, accountID: nil, query: "x", before: nil),
                       "/api/emails?folder=all&q=x")
    }

    func testSearchScopeMatchesTheWeb() {
        // Most folders search all mail; Spam, Drafts and Trash search in place.
        XCTAssertEqual(EmailsStore.listPath(folder: .starred, accountID: nil, query: "x", before: nil),
                       "/api/emails?folder=all&q=x")
        for folder in [MailFolder.spam, .drafts, .trash] {
            XCTAssertEqual(EmailsStore.searchScope(folder: folder, label: nil), folder)
            XCTAssertEqual(EmailsStore.listPath(folder: folder, accountID: nil, query: "x", before: nil),
                           "/api/emails?folder=\(folder.rawValue)&q=x")
        }
        XCTAssertEqual(EmailsStore.searchScope(folder: .inbox, label: nil), .all)
    }

    func testReplyFromSentGoesToTheRecipients() {
        func email(sender: String, receiver: String?) -> EmailSummary {
            EmailSummary(id: 1, accountId: 2, subject: "Hi", sender: sender, receiver: receiver,
                         isRead: true, isStarred: nil, hasAttachments: nil, createdAt: nil, sortAt: nil)
        }
        // Someone else's email: reply to them.
        XCTAssertEqual(ComposeView.replyAddress(email(sender: "Ana <ana@x.com>", receiver: "me@x.com"),
                                                mailbox: "me@x.com"), "ana@x.com")
        // One you sent: reply to whoever you sent it to.
        XCTAssertEqual(ComposeView.replyAddress(email(sender: "Me <ME@x.com>", receiver: "Ana <ana@x.com>, bo@x.com"),
                                                mailbox: "me@x.com"), "ana@x.com, bo@x.com")
        // Unknown mailbox: the sender, as before.
        XCTAssertEqual(ComposeView.replyAddress(email(sender: "me@x.com", receiver: "ana@x.com"), mailbox: nil),
                       "me@x.com")
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
