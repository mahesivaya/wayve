import XCTest
@testable import Fluxze

/// End-to-end against a running dev stack. Skipped unless these are set, e.g.
///   TEST_RUNNER_FLUXZE_LIVE_URL=http://localhost
///   TEST_RUNNER_FLUXZE_LIVE_EMAIL=… TEST_RUNNER_FLUXZE_LIVE_PASSWORD=…
///   TEST_RUNNER_FLUXZE_MAILPIT=http://localhost:8025   (optional, for the verify step)
/// The account must be a freshly registered, throwaway personal account: the
/// test deletes it at the end.
@MainActor
final class LiveAPITests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testFullTaskFlowAgainstDevStack() async throws {
        guard let base = env["FLUXZE_LIVE_URL"].flatMap(URL.init(string:)),
              let email = env["FLUXZE_LIVE_EMAIL"],
              let password = env["FLUXZE_LIVE_PASSWORD"] else {
            throw XCTSkip("FLUXZE_LIVE_* not set")
        }
        let api = APIClient(baseURL: base)
        let auth = AuthService(api: api)

        var outcome = try await auth.login(identifier: email, password: password)
        if case .emailUnverified = outcome {
            let mailpit = try XCTUnwrap(env["FLUXZE_MAILPIT"].flatMap(URL.init(string:)),
                                        "email unverified and FLUXZE_MAILPIT not set")
            let code = try await latestCode(for: email, mailpit: mailpit)
            try await auth.verifyEmail(email: email, code: code)
            outcome = try await auth.login(identifier: email, password: password)
        }
        guard case .signedIn(let token) = outcome else { return XCTFail("not signed in: \(outcome)") }
        api.token = token

        let me: Me = try await api.get("/api/me")
        XCTAssertEqual(me.email, email)

        let store = TasksStore(api: api)
        await store.load()
        XCTAssertNil(store.errorMessage)
        XCTAssertFalse(store.statuses.isEmpty)
        let before = store.tasks.count

        try await store.create(TaskInput(name: "From the iPhone app", description: "live test", priority: 2))
        let created = try XCTUnwrap(store.tasks.last)
        XCTAssertEqual(store.tasks.count, before + 1)
        XCTAssertEqual(created.priority, 2)
        XCTAssertNotNil(created.createdAt)
        XCTAssertFalse(store.isFinished(created))

        var edit = TaskInput(from: created)
        edit.name = "From the iPhone app (edited)"
        try await store.update(created, with: edit)
        XCTAssertEqual(store.tasks.first { $0.id == created.id }?.name, "From the iPhone app (edited)")

        let done = try XCTUnwrap(store.statuses.first { $0.category == "completed" })
        let current = try XCTUnwrap(store.tasks.first { $0.id == created.id })
        await store.setStatus(current, to: done.slug)
        XCTAssertNil(store.errorMessage)
        let finished = try XCTUnwrap(store.tasks.first { $0.id == created.id })
        XCTAssertTrue(store.isFinished(finished))
        XCTAssertEqual(finished.priority, 2, "status change must not reset other fields")

        // A fresh load sees the server's copy.
        await store.load()
        XCTAssertEqual(store.tasks.first { $0.id == created.id }?.status, done.slug)

        await store.delete(finished)
        XCTAssertNil(store.errorMessage)
        await store.load()
        XCTAssertNil(store.tasks.first { $0.id == created.id })

        // Clean up: delete the throwaway account, then the old token is refused.
        try await api.delete("/api/me")
        do {
            let _: Me = try await api.get("/api/me")
            XCTFail("deleted account still authenticates")
        } catch {
            XCTAssertEqual(error as? APIError,
                           .unauthorized("Your session has expired. Please sign in again."))
        }
    }

    private func latestCode(for email: String, mailpit: URL) async throws -> String {
        struct Search: Decodable { struct Item: Decodable { let ID: String }; let messages: [Item] }
        struct Message: Decodable { let Text: String }
        var search = URLComponents(url: mailpit.appendingPathComponent("/api/v1/search"), resolvingAgainstBaseURL: false)!
        search.queryItems = [URLQueryItem(name: "query", value: "to:\"\(email)\"")]
        let (listData, _) = try await URLSession.shared.data(from: search.url!)
        let id = try XCTUnwrap(JSONDecoder().decode(Search.self, from: listData).messages.first?.ID)
        let (messageData, _) = try await URLSession.shared.data(from: mailpit.appendingPathComponent("/api/v1/message/\(id)"))
        let text = try JSONDecoder().decode(Message.self, from: messageData).Text
        let range = try XCTUnwrap(text.range(of: #"\b\d{6}\b"#, options: .regularExpression))
        return String(text[range])
    }
}
