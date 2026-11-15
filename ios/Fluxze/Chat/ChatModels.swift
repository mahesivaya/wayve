import Foundation

/// Someone in the chat directory (`GET /api/users/all`).
struct ChatUser: Codable, Identifiable, Hashable {
    let id: Int
    let email: String
    /// SPKI DER bytes; nil until they've opened Fluxze and set up encryption.
    let publicKey: [UInt8]?
    /// From the by-email lookup only: false when the rules forbid a DM.
    var canMessage: Bool? = nil
}

/// A channel (`GET /api/chat/channels`); only the fields the app shows.
struct ChatChannel: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let isMember: Bool
    let memberIds: [Int]
    let lastMessageAt: Date?
}

/// `GET /api/chat/conversations`: the DMs, with unread counts.
struct ChatSummary: Decodable {
    let totalUnread: Int
    let conversations: [DM]

    struct DM: Decodable {
        let userId: Int
        let unreadCount: Int
        let lastMessageAt: Date?
    }
}

/// One message, from history or the socket; the wire shape of both
/// (`models/message.rs` ChatMessage / Message).
struct ChatWireMessage: Codable, Equatable {
    var messageId: Int?
    let senderId: Int
    var senderName: String?
    var receiverId: Int?
    var channelId: Int?
    let content: String
    var status: String?
    var createdAt: Date?
    var clientId: String?
    /// Set on a channel thread reply; the app lists top-level messages only.
    var parentMessageId: Int?
}

/// A conversation in the Chat tab: a DM with one person, or a channel.
enum ChatConversation: Hashable, Identifiable {
    case dm(ChatUser)
    case channel(ChatChannel)

    var id: String {
        switch self {
        case .dm(let user): "dm:\(user.id)"
        case .channel(let channel): "channel:\(channel.id)"
        }
    }

    var title: String {
        switch self {
        case .dm(let user): user.email
        case .channel(let channel): "# \(channel.name)"
        }
    }

    /// Whether a message belongs to this conversation (the socket carries all).
    func contains(_ message: ChatWireMessage, me: Int) -> Bool {
        switch self {
        case .channel(let channel):
            return message.channelId == channel.id
        case .dm(let user):
            guard message.channelId == nil else { return false }
            return (message.senderId == user.id && message.receiverId == me)
                || (message.senderId == me && message.receiverId == user.id)
        }
    }
}

/// A message ready to show: its text opened, or why it can't be.
struct ChatBubble: Identifiable, Equatable {
    /// The server id, or the client id while it's on its way.
    let id: String
    let messageId: Int?
    let clientId: String?
    let senderId: Int
    let senderName: String?
    let body: ChatCrypto.Opened
    let createdAt: Date?
    var state: State = .sent

    enum State: Equatable { case sending, sent, failed }

    var text: String {
        switch body {
        case .text(let text): text
        case .locked: "Encrypted message. Unlock your key on this iPhone to read it."
        case .notForYou: "Sent before you set up encryption."
        case .unreadable: "This message couldn't be decrypted."
        }
    }

    var isReadable: Bool {
        if case .text = body { return true }
        return false
    }
}

/// Whether someone is in chat right now (`GET /api/chat/presence`, and live
/// `presence` frames): online with their chosen status, or when last seen.
struct ChatPresence: Equatable {
    let online: Bool
    let lastSeen: Date?
    /// active, away or dnd: the status they picked, shown while online.
    let status: String

    enum Kind: Equatable { case active, away, dnd, offline }

    /// Offline wins over the chosen status, as on the web.
    var kind: Kind {
        guard online else { return .offline }
        switch status {
        case "away": return .away
        case "dnd": return .dnd
        default: return .active
        }
    }

    var label: String {
        switch kind {
        case .active: "Active"
        case .away: "Away"
        case .dnd: "Do Not Disturb"
        case .offline: "Offline"
        }
    }

    /// "Active", "Away", or "Last seen 5 min ago" when offline.
    func line(now: Date = .now) -> String {
        guard kind == .offline, let lastSeen else { return label }
        return "Last seen \(lastSeen.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))"
    }
}

/// One row of `GET /api/chat/presence?ids=…` and of a live `presence` frame.
struct ChatPresenceEntry: Decodable {
    let userId: Int
    let online: Bool?
    let lastSeen: Date?
    let status: String?

    var presence: ChatPresence {
        ChatPresence(online: online ?? false, lastSeen: lastSeen, status: status ?? "active")
    }
}
