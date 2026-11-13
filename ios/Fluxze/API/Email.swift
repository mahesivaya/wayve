import Foundation

/// A connected mailbox (`GET /api/accounts`), the same list the web inbox shows.
struct MailAccount: Codable, Identifiable, Hashable {
    let id: Int
    let email: String
    let displayName: String?
    let unreadCount: Int?
    let isShared: Bool?
    let sharedLabel: String?

    var label: String {
        if let sharedLabel, !sharedLabel.isEmpty { return sharedLabel }
        if let displayName, !displayName.isEmpty { return displayName }
        return email
    }
}

/// One row of `GET /api/emails` (per email, not grouped into conversations).
struct EmailSummary: Codable, Identifiable, Hashable {
    let id: Int
    let accountId: Int?
    let subject: String?
    let sender: String?
    let receiver: String?
    var isRead: Bool
    let isStarred: Bool?
    let hasAttachments: Bool?
    let createdAt: Date?
    let sortAt: Date?

    /// The list's order and paging cursor, as the server sorts it.
    var listDate: Date? { sortAt ?? createdAt }

    var displaySubject: String {
        let s = subject?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return s.isEmpty ? "(no subject)" : s
    }
}

/// The folders the ☰ menu offers, by their `/api/emails?folder=` value.
enum MailFolder: String, CaseIterable, Identifiable {
    case inbox, starred, snoozed, important, sent, drafts, all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .starred: "Starred"
        case .snoozed: "Snoozed"
        case .important: "Important"
        case .sent: "Sent"
        case .drafts: "Drafts"
        case .all: "All Mail"
        }
    }

    var systemImage: String {
        switch self {
        case .inbox: "tray"
        case .starred: "star"
        case .snoozed: "clock"
        case .important: "tag"
        case .sent: "paperplane"
        case .drafts: "doc"
        case .all: "envelope.open"
        }
    }
}

/// `GET /api/emails/{id}/body`.
struct EmailBodyResponse: Decodable {
    let body: String?
}

enum EmailText {
    /// Bodies the server can't read: sealed to the owner's browser key on
    /// arrival, or a Fluxze-to-Fluxze end-to-end message.
    static let sealedPrefixes = ["WAYVE_SECURE_V1", "WAYVE_CHAT_E2E_V1"]

    static func isSealed(_ body: String) -> Bool {
        sealedPrefixes.contains { body.hasPrefix($0) }
    }

    /// "Ayana Rao <ayana@x.com>" → "Ayana Rao"; a bare address stays as is.
    static func name(of header: String?) -> String {
        let raw = header?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty else { return "Unknown sender" }
        if let lt = raw.firstIndex(of: "<") {
            let name = raw[..<lt]
                .trimmingCharacters(in: .whitespaces)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            if !name.isEmpty { return name }
            return address(of: raw)
        }
        return raw
    }

    /// "Ayana Rao <ayana@x.com>" → "ayana@x.com".
    static func address(of header: String) -> String {
        guard let lt = header.firstIndex(of: "<"),
              let gt = header[lt...].firstIndex(of: ">") else {
            return header.trimmingCharacters(in: .whitespaces)
        }
        return String(header[header.index(after: lt)..<gt])
    }

    /// Whether a body is HTML rather than plain text.
    static func isHTML(_ body: String) -> Bool {
        body.range(of: #"<(html|body|div|p|br|table|span|a|img)\b"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
    }
}
