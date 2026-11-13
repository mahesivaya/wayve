import Foundation

/// Decodes and discards any JSON body, for endpoints whose response the app
/// doesn't need (`{"deleted":true}`, `{"message":…}`).
struct Ignored: Decodable {
    init(from decoder: Decoder) throws {}
}

private struct NoBody: Encodable {}

@MainActor
final class APIClient {
    let baseURL: URL
    private let session: URLSession
    /// The JWT, sent as `Authorization: Bearer`. The server also sets a cookie
    /// at login; the ephemeral session discards it so sign-out is complete.
    var token: String?
    /// Called when a request that carried a token gets a 401.
    var onUnauthorized: (() -> Void)?

    init(baseURL: URL, token: String? = nil, configuration: URLSessionConfiguration = .ephemeral) {
        self.baseURL = baseURL
        self.token = token
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: configuration)
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = ServerDate.parse(text) else {
                throw DecodingError.dataCorruptedError(
                    in: container, debugDescription: "Unrecognized date: \(text)")
            }
            return date
        }
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await send("GET", path, body: Optional<NoBody>.none)
    }

    func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        try await send("POST", path, body: body)
    }

    func put<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        try await send("PUT", path, body: body)
    }

    func delete(_ path: String) async throws {
        let _: Ignored = try await send("DELETE", path, body: Optional<NoBody>.none)
    }

    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError.network("Invalid address: \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let sentToken = token
        if let sentToken {
            request.setValue("Bearer \(sentToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network("Can't reach Fluxze. Check your connection and try again.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.network("No response from the server.")
        }

        guard (200..<300).contains(http.statusCode) else {
            let error = APIError.from(status: http.statusCode, data: data)
            if case .unauthorized = error, sentToken != nil {
                onUnauthorized?()
            }
            throw error
        }

        // A caller that ignores the body accepts any 2xx, including an empty or
        // plain-text one ("Email sent ✅" from POST /api/emails).
        if T.self == Ignored.self {
            return try Self.decoder.decode(T.self, from: Data("{}".utf8))
        }
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }
}
