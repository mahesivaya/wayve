import Foundation

/// A connected mailbox (`GET /api/accounts`), the same list the web inbox shows.
struct MailAccount: Codable, Identifiable, Hashable {
    let id: Int
    let email: String
    let displayName: String?
    var unreadCount: Int?
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
    var isStarred: Bool?
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
    // Menu order, as in Gmail: Updates with Important, Spam just above Trash.
    case inbox, starred, snoozed, important, updates, sent, drafts, all, spam, trash

    var id: String { rawValue }

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .starred: "Starred"
        case .snoozed: "Snoozed"
        case .important: "Important"
        case .updates: "Updates"
        case .sent: "Sent"
        case .drafts: "Drafts"
        case .all: "All Mail"
        case .spam: "Spam"
        case .trash: "Trash"
        }
    }

    var systemImage: String {
        switch self {
        case .inbox: "tray"
        case .starred: "star"
        case .snoozed: "clock"
        case .important: "tag"
        case .updates: "info.circle"
        case .sent: "paperplane"
        case .drafts: "doc"
        case .all: "envelope.open"
        case .spam: "exclamationmark.octagon"
        case .trash: "trash"
        }
    }
}

/// A label from one mailbox (`GET /api/emails/sidebar` → `labels`): Gmail's
/// own user labels, with nested ones written "parent/child".
struct MailLabel: Codable, Identifiable, Hashable {
    let accountId: Int
    let accountEmail: String
    let labelId: String
    let name: String
    let color: String?
    let unread: Int?

    var id: String { "\(accountId):\(labelId)" }

    /// The `folder` value that lists this label's mail.
    var folderKey: String { "label:\(accountId):\(labelId)" }
}

struct MailSidebar: Decodable {
    let labels: [MailLabel]
}

/// `GET /api/emails/{id}`: the header fields the list row doesn't carry.
struct EmailDetail: Decodable {
    /// null until known (mail synced before Cc was stored), "" for none.
    let cc: String?
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

    /// Splits a To/Cc header into one entry per person, ignoring commas inside
    /// quoted names ("Rao, Ayana" <a@x.com>) and <addresses>.
    static func splitAddresses(_ header: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var inQuotes = false
        var inAngle = false
        for ch in header {
            switch ch {
            case "\"": inQuotes.toggle()
            case "<": inAngle = true
            case ">": inAngle = false
            case ",", ";":
                if !inQuotes && !inAngle {
                    parts.append(current)
                    current = ""
                    continue
                }
            default: break
            }
            current.append(ch)
        }
        parts.append(current)
        return parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// A body as plain text, for quoting in a reply, translating and sharing:
    /// HTML loses its tags (line breaks kept), plain text is returned as is.
    static func plainText(_ body: String) -> String {
        guard isHTML(body) else { return body.trimmingCharacters(in: .whitespacesAndNewlines) }
        var text = body
        let replacements: [(String, String)] = [
            (#"(?is)<(script|style|head)\b.*?</\1>"#, ""),
            (#"(?i)<br\s*/?>"#, "\n"),
            (#"(?i)</(p|div|tr|li|h[1-6]|table|blockquote)>"#, "\n"),
            (#"(?i)<li\b[^>]*>"#, "• "),
            (#"<[^>]+>"#, ""),
        ]
        for (pattern, template) in replacements {
            text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        let entities = ["&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'"]
        for (entity, char) in entities {
            text = text.replacingOccurrences(of: entity, with: char)
        }
        return text
            .replacingOccurrences(of: #"[ \t]+\n"#, with: "\n", options: .regularExpression)
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether a body is HTML rather than plain text.
    static func isHTML(_ body: String) -> Bool {
        body.range(of: #"<(html|body|div|p|br|table|span|a|img)\b"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
    }
}
