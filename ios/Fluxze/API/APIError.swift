import Foundation

enum APIError: Error, LocalizedError, Equatable {
    /// 401. The session is missing, expired, or the credentials are wrong.
    case unauthorized(String)
    /// Any other non-2xx response. `code` is the `error` field when the server
    /// sends one (for example `email_unverified`).
    case server(status: Int, code: String?, message: String)
    case network(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized(let message): return message
        case .server(_, _, let message): return message
        case .network(let message): return message
        case .decoding: return "The server sent a response the app couldn't read."
        }
    }

    var code: String? {
        if case .server(_, let code, _) = self { return code }
        return nil
    }

    /// Builds an error from a failed response. The backend answers with
    /// `{"message"}`, `{"error","message"}`, plain text, or an empty body.
    static func from(status: Int, data: Data) -> APIError {
        var message: String?
        var code: String?
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            message = object["message"] as? String
            code = object["error"] as? String
        } else if let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, text.count < 300 {
            message = text
        }
        if let m = message, m.isEmpty { message = nil }

        switch status {
        case 401:
            let text = message ?? "Your session has expired. Please sign in again."
            return .unauthorized(text == "unauthorized" ? "Your session has expired. Please sign in again." : text)
        case 429:
            return .server(status: status, code: code,
                           message: message ?? "Too many attempts. Please wait a minute and try again.")
        case 500...:
            return .server(status: status, code: code,
                           message: "Something went wrong on the server. Please try again.")
        default:
            return .server(status: status, code: code,
                           message: message ?? "Request failed (\(status)).")
        }
    }
}
