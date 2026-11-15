import Foundation
import Security

/// The Chat tab: the conversation list, the open conversation, and the live
/// socket. Same endpoints and wire format as the web chat (`frontend/src/chat`).
@MainActor
final class ChatStore: ObservableObject {
    @Published private(set) var users: [ChatUser] = []
    @Published private(set) var channels: [ChatChannel] = []
    @Published private(set) var summary: [Int: ChatSummary.DM] = [:]
    @Published private(set) var totalUnread = 0
    @Published private(set) var hasLoaded = false
    @Published var errorMessage: String?

    /// The open conversation and its messages, oldest first.
    @Published private(set) var current: ChatConversation?
    @Published private(set) var bubbles: [ChatBubble] = []
    @Published private(set) var isLoadingMessages = false
    @Published private(set) var isConnected = false

    let api: APIClient
    let me: Me?
    private let socket: ChatSocket
    private var names: [Int: String] = [:]

    init(api: APIClient, me: Me?) {
        self.api = api
        self.me = me
        socket = ChatSocket(baseURL: api.baseURL, token: { [weak api] in api?.token })
        socket.onFrame = { [weak self] data in self?.handle(frame: data) }
        socket.onOpen = { [weak self] in Task { await self?.resync() } }
        socket.onStateChange = { [weak self] connected in self?.isConnected = connected }
    }

    var myID: Int? { me?.id }

    /// Whether sending needs this phone's key (personal accounts' end-to-end
    /// chat). Organization and platform accounts send text the server encrypts.
    var sendsEncrypted: Bool { !(me?.usesStandardChatEncryption ?? false) }

    var canSend: Bool { !sendsEncrypted || KeyVault.hasKey }

    // MARK: Loading

    func start() {
        socket.start()
    }

    func stop() {
        socket.stop()
    }

    func load() async {
        do {
            async let directory: [ChatUser] = api.get("/api/users/all")
            async let channelList: [ChatChannel] = api.get("/api/chat/channels")
            async let dms: ChatSummary = api.get("/api/chat/conversations")
            let (u, c, s) = try await (directory, channelList, dms)
            users = u
            channels = c.filter(\.isMember)
            apply(summary: s)
            for user in u { names[user.id] = user.email }
            await fillMissingNames()
            errorMessage = nil
        } catch APIError.unauthorized {
            // AppState signs out.
        } catch {
            errorMessage = error.localizedDescription
        }
        hasLoaded = true
    }

    private func apply(summary s: ChatSummary) {
        summary = Dictionary(s.conversations.map { ($0.userId, $0) }, uniquingKeysWith: { a, _ in a })
        totalUnread = s.totalUnread
    }

    /// DMs with someone outside the directory still get a name and key.
    private func fillMissingNames() async {
        for id in summary.keys where names[id] == nil {
            _ = await refreshPeer(id)
        }
    }

    /// Asks the server for someone's current email and public key, as the web
    /// does before refusing a send: the directory is loaded once, and personal
    /// accounts only list people already talked to, so a new contact (or one
    /// who set up encryption since) looks keyless until looked up again.
    @discardableResult
    func refreshPeer(_ id: Int) async -> ChatUser? {
        struct Profile: Decodable { let email: String }
        var email = names[id]
        if email == nil {
            email = (try? await api.get("/api/chat/users/\(id)/profile") as Profile)?.email
        }
        guard let email else { return nil }
        names[id] = email
        var components = URLComponents()
        components.path = "/api/users"
        components.queryItems = [URLQueryItem(name: "email", value: email)]
        guard let path = components.string,
              let found: ChatUser? = try? await api.get(path),
              let found, found.id == id else { return nil }
        if let index = users.firstIndex(where: { $0.id == id }) {
            users[index] = found
        } else {
            users.append(found)
        }
        return found
    }

    func user(_ id: Int) -> ChatUser {
        users.first { $0.id == id } ?? ChatUser(id: id, email: names[id] ?? "User \(id)", publicKey: nil)
    }

    /// DMs and channels, most recent first.
    var conversations: [ChatConversation] {
        let dms = summary.values.map { (ChatConversation.dm(user($0.userId)), $0.lastMessageAt) }
        let rooms = channels.map { (ChatConversation.channel($0), $0.lastMessageAt) }
        return (dms + rooms)
            .sorted { ($0.1 ?? .distantPast) > ($1.1 ?? .distantPast) }
            .map(\.0)
    }

    func unread(_ conversation: ChatConversation) -> Int {
        if case .dm(let user) = conversation { return summary[user.id]?.unreadCount ?? 0 }
        return 0
    }

    func lastActivity(_ conversation: ChatConversation) -> Date? {
        switch conversation {
        case .dm(let user): summary[user.id]?.lastMessageAt
        case .channel(let channel): channel.lastMessageAt
        }
    }

    /// People a new DM can go to: the directory, minus yourself.
    var directory: [ChatUser] {
        users.filter { $0.id != myID }.sorted { $0.email.localizedCaseInsensitiveCompare($1.email) == .orderedAscending }
    }

    // MARK: A conversation

    func open(_ conversation: ChatConversation) async {
        current = conversation
        bubbles = []
        isLoadingMessages = true
        defer { isLoadingMessages = false }
        do {
            let rows: [ChatWireMessage] = try await api.get(historyPath(conversation, sinceID: nil))
            guard current == conversation else { return }
            bubbles = Self.sorted(rows.filter { $0.parentMessageId == nil }).map(bubble)
            // Fetching a DM's history marks it read on the server.
            if case .dm(let user) = conversation, let dm = summary[user.id] {
                summary[user.id] = ChatSummary.DM(userId: dm.userId, unreadCount: 0, lastMessageAt: dm.lastMessageAt)
                totalUnread = max(totalUnread - dm.unreadCount, 0)
            }
        } catch APIError.unauthorized {
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func close() {
        current = nil
        bubbles = []
    }

    func historyPath(_ conversation: ChatConversation, sinceID: Int?) -> String {
        var items: [URLQueryItem]
        let path: String
        switch conversation {
        case .dm(let user):
            path = "/api/chat/direct-messages"
            items = [URLQueryItem(name: "user1", value: String(myID ?? 0)),
                     URLQueryItem(name: "user2", value: String(user.id))]
        case .channel(let channel):
            path = "/api/chat/channel-messages"
            items = [URLQueryItem(name: "channel_id", value: String(channel.id))]
        }
        if let sinceID { items.append(URLQueryItem(name: "since_id", value: String(sinceID))) }
        var components = URLComponents()
        components.path = path
        components.queryItems = items
        return components.string ?? path
    }

    /// History comes newest first (DMs) or oldest first (a `since_id` fetch).
    static func sorted(_ rows: [ChatWireMessage]) -> [ChatWireMessage] {
        rows.sorted {
            let a = $0.createdAt ?? .distantPast, b = $1.createdAt ?? .distantPast
            return a == b ? ($0.messageId ?? 0) < ($1.messageId ?? 0) : a < b
        }
    }

    private func bubble(_ row: ChatWireMessage) -> ChatBubble {
        ChatBubble(
            id: row.messageId.map { "m\($0)" } ?? row.clientId ?? UUID().uuidString,
            messageId: row.messageId,
            clientId: row.clientId,
            senderId: row.senderId,
            senderName: row.senderName,
            body: ChatCrypto.open(row.content, userID: myID, key: KeyVault.privateKey()),
            createdAt: row.createdAt
        )
    }

    /// After a reconnect: fetch what arrived while the socket was down.
    private func resync() async {
        guard let conversation = current else {
            if let s: ChatSummary = try? await api.get("/api/chat/conversations") { apply(summary: s) }
            return
        }
        let since = bubbles.compactMap(\.messageId).max()
        guard let rows: [ChatWireMessage] = try? await api.get(historyPath(conversation, sinceID: since)),
              current == conversation else { return }
        merge(rows.filter { $0.parentMessageId == nil })
    }

    private func merge(_ rows: [ChatWireMessage]) {
        let known = Set(bubbles.compactMap(\.messageId))
        let fresh = Self.sorted(rows.filter { $0.messageId.map { !known.contains($0) } ?? true })
        bubbles.append(contentsOf: fresh.map(bubble))
    }

    // MARK: Sending

    enum SendError: LocalizedError {
        case offline, locked, noKey(String)

        var errorDescription: String? {
            switch self {
            case .offline: "Chat isn't connected. Check your connection and try again."
            case .locked: "Unlock your encryption key on this iPhone to send messages."
            case .noKey(let who): "Can't send: \(who) hasn't set up encryption yet. They just need to open Fluxze once."
            }
        }
    }

    func send(_ text: String) async throws {
        let plain = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !plain.isEmpty, let conversation = current, let me = myID else { return }
        guard isConnected else { throw SendError.offline }
        // A DM peer without a known key may have set one up since: look again.
        if sendsEncrypted, case .dm(let peer) = conversation,
           (users.first { $0.id == peer.id }?.publicKey ?? []).isEmpty {
            await refreshPeer(peer.id)
        }

        let content = sendsEncrypted ? try seal(plain, for: conversation, me: me) : plain
        let clientID = UUID().uuidString.lowercased()
        var frame = ChatWireMessage(senderId: me, content: content, status: "sent",
                                    createdAt: Date(), clientId: clientID)
        switch conversation {
        case .dm(let user): frame.receiverId = user.id
        case .channel(let channel): frame.channelId = channel.id
        }
        guard socket.send(try Self.frameEncoder.encode(frame)) else { throw SendError.offline }
        bubbles.append(ChatBubble(id: clientID, messageId: nil, clientId: clientID, senderId: me,
                                  senderName: nil, body: .text(plain), createdAt: Date(), state: .sending))
    }

    /// The sender and every recipient with a published key, as the web does:
    /// a DM refuses a peer without a key, a channel skips members without one.
    private func seal(_ text: String, for conversation: ChatConversation, me: Int) throws -> String {
        guard let privateKey = KeyVault.privateKey(), let mine = SecKeyCopyPublicKey(privateKey) else {
            throw SendError.locked
        }
        var recipients: [Int: SecKey] = [me: mine]
        switch conversation {
        case .dm(let peer):
            let current = users.first { $0.id == peer.id } ?? peer
            guard let spki = current.publicKey, !spki.isEmpty, let key = try? ChatCrypto.publicKey(spki: spki) else {
                throw SendError.noKey(current.email)
            }
            recipients[peer.id] = key
        case .channel(let channel):
            for id in channel.memberIds where id != me {
                if let spki = users.first(where: { $0.id == id })?.publicKey, !spki.isEmpty,
                   let key = try? ChatCrypto.publicKey(spki: spki) {
                    recipients[id] = key
                }
            }
        }
        return try ChatCrypto.seal(text, for: recipients)
    }

    /// Frames go out with the server's snake_case names, dates as RFC 3339.
    static let frameEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    // MARK: Socket frames

    private struct Typed: Decodable {
        let type: String?
        let clientId: String?
        let userId: Int?
    }

    func handle(frame data: Data) {
        guard let typed = try? APIClient.decoder.decode(Typed.self, from: data) else { return }
        switch typed.type {
        case nil:
            if let message = try? APIClient.decoder.decode(ChatWireMessage.self, from: data) {
                receive(message)
            }
        case "send_failed":
            if let id = typed.clientId, let index = bubbles.firstIndex(where: { $0.clientId == id }) {
                bubbles[index].state = .failed
            }
        case "conversation_read":
            if let id = typed.userId, let dm = summary[id] {
                summary[id] = ChatSummary.DM(userId: id, unreadCount: 0, lastMessageAt: dm.lastMessageAt)
            }
        default:
            break  // presence, reactions and read ticks aren't shown yet
        }
    }

    private func receive(_ message: ChatWireMessage) {
        guard let me = myID, message.parentMessageId == nil else { return }
        // Read receipts and other status-only frames carry no content.
        if message.content.isEmpty { return }

        if let conversation = current, conversation.contains(message, me: me) {
            if let clientID = message.clientId,
               let index = bubbles.firstIndex(where: { $0.clientId == clientID && $0.messageId == nil }) {
                // Our own message, confirmed: keep the text we already show.
                let mine = bubbles[index]
                bubbles[index] = ChatBubble(id: mine.id, messageId: message.messageId, clientId: clientID,
                                            senderId: mine.senderId, senderName: mine.senderName,
                                            body: mine.body, createdAt: message.createdAt ?? mine.createdAt)
            } else if !bubbles.contains(where: { $0.messageId != nil && $0.messageId == message.messageId }) {
                bubbles.append(bubble(message))
                if case .dm(let user) = conversation, message.senderId == user.id {
                    sendReadReceipt(to: user.id, me: me)
                }
            }
            touch(conversation, at: message.createdAt)
            return
        }

        // Another conversation: bump its unread count and move it up.
        if message.channelId == nil, message.senderId != me {
            // Someone new: fetch their name (and key) for the list.
            if names[message.senderId] == nil, !users.contains(where: { $0.id == message.senderId }) {
                Task { await refreshPeer(message.senderId) }
            }
            let dm = summary[message.senderId]
            summary[message.senderId] = ChatSummary.DM(
                userId: message.senderId, unreadCount: (dm?.unreadCount ?? 0) + 1,
                lastMessageAt: message.createdAt ?? Date())
            totalUnread += 1
        } else if let channelID = message.channelId,
                  let channel = channels.first(where: { $0.id == channelID }) {
            touch(.channel(channel), at: message.createdAt)
        }
    }

    private func touch(_ conversation: ChatConversation, at date: Date?) {
        let when = date ?? Date()
        switch conversation {
        case .dm(let user):
            let dm = summary[user.id]
            summary[user.id] = ChatSummary.DM(userId: user.id, unreadCount: dm?.unreadCount ?? 0, lastMessageAt: when)
        case .channel(let channel):
            if let index = channels.firstIndex(where: { $0.id == channel.id }) {
                let c = channels[index]
                channels[index] = ChatChannel(id: c.id, name: c.name, isMember: c.isMember,
                                              memberIds: c.memberIds, lastMessageAt: when)
            }
        }
    }

    /// Marks what `other` sent as read (the server takes the reader from the
    /// session; the other fields only satisfy the frame's shape).
    private func sendReadReceipt(to other: Int, me: Int) {
        let frame = ChatWireMessage(senderId: me, receiverId: other, content: "", status: "read")
        if let data = try? Self.frameEncoder.encode(frame) { socket.send(data) }
    }
}
