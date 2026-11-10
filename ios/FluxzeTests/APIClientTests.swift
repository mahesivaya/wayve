import XCTest
@testable import Fluxze

/// Serves canned responses and records requests.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var recorded = request
        if recorded.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            recorded.httpBody = data
        }
        Self.requests.append(recorded)
        let (status, body) = Self.handler?(recorded) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class APIClientTests: XCTestCase {
    private func makeClient(token: String? = "jwt-123") -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        StubProtocol.requests = []
        return APIClient(baseURL: URL(string: "https://example.test")!, token: token, configuration: configuration)
    }

    func testSendsBearerAndDecodes() async throws {
        let client = makeClient()
        StubProtocol.handler = { _ in (200, Data(#"[{"id":1,"name":"Repo"}]"#.utf8)) }
        let projects: [Project] = try await client.get("/api/projects")
        XCTAssertEqual(projects, [Project(id: 1, name: "Repo")])
        let request = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://example.test/api/projects")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer jwt-123")
    }

    func testUnauthorizedTriggersSignOut() async {
        let client = makeClient()
        var signedOut = false
        client.onUnauthorized = { signedOut = true }
        StubProtocol.handler = { _ in (401, Data(#"{"message":"unauthorized"}"#.utf8)) }
        do {
            let _: [TaskItem] = try await client.get("/api/tasks")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized("Your session has expired. Please sign in again."))
        }
        XCTAssertTrue(signedOut)
    }

    func testDeleteAcceptsEmptyBody() async throws {
        let client = makeClient()
        StubProtocol.handler = { _ in (200, Data()) }
        try await client.delete("/api/tasks/5")
        XCTAssertEqual(StubProtocol.requests.first?.httpMethod, "DELETE")
    }

    /// Scheme-2 sign-in sends the derived key, never the password.
    func testLoginSendsAuthKeyNotPassword() async throws {
        let client = makeClient(token: nil)
        StubProtocol.handler = { request in
            if request.url?.path == "/api/auth/prelogin" {
                return (200, Data(#"{"scheme":2,"auth_salt":"AAECAwQFBgcICQoLDA0ODw=="}"#.utf8))
            }
            return (200, Data(#"{"token":"new-jwt","account_type":"personal"}"#.utf8))
        }
        let outcome = try await AuthService(api: client).login(identifier: " me@example.com ", password: "correct horse ⚡ battery")
        XCTAssertEqual(outcome, .signedIn(token: "new-jwt"))

        let login = try XCTUnwrap(StubProtocol.requests.last?.httpBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: login) as? [String: Any])
        XCTAssertEqual(body["email"] as? String, "me@example.com")
        XCTAssertEqual(body["auth_key"] as? String, "X17/d/XSukeZfR3K0rgjuBYqXFtsqPGzfZaNy2xZ+IU=")
        XCTAssertNil(body["password"])
    }

    func testUnverifiedEmailOutcome() async throws {
        let client = makeClient(token: nil)
        StubProtocol.handler = { request in
            if request.url?.path == "/api/auth/prelogin" {
                return (200, Data(#"{"scheme":1,"auth_salt":null}"#.utf8))
            }
            return (403, Data(#"{"error":"email_unverified","message":"Please verify your email"}"#.utf8))
        }
        let outcome = try await AuthService(api: client).login(identifier: "me@example.com", password: "pw")
        XCTAssertEqual(outcome, .emailUnverified(message: "Please verify your email"))
    }
}
