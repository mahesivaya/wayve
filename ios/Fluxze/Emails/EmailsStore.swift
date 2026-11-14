import Foundation
import Security

/// The inbox, read from the same `/api/emails` the web app uses, so the phone
/// shows the mail of every mailbox the user connected in the browser.
@MainActor
final class EmailsStore: ObservableObject {
    /// The server's page size (`routes/email.rs::get_emails`).
    static let pageSize = 25

    @Published private(set) var emails: [EmailSummary] = []
    @Published private(set) var accounts: [MailAccount] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var hasMore = false
    @Published var errorMessage: String?
    /// nil = every mailbox.
    @Published var accountID: Int?
    @Published var folder: MailFolder = .inbox
    /// A label being listed instead of `folder`.
    @Published var label: MailLabel?
    /// The labels of every mailbox, for the ☰ menu.
    @Published private(set) var labels: [MailLabel] = []
    @Published var query = ""

    let api: APIClient
    /// The signed-in user, for their slot in multi-recipient envelopes.
    let userID: Int?
    /// Bumped per reload, so a slow older response can't overwrite a newer one.
    private var generation = 0

    init(api: APIClient, userID: Int? = nil) {
        self.api = api
        self.userID = userID
    }

    /// A search looks through all mail, as on the web.
    static func listPath(folder: MailFolder, label: MailLabel? = nil, accountID: Int?, query: String, before: EmailSummary?) -> String {
        let shown = label?.folderKey ?? folder.rawValue
        var items = [URLQueryItem(name: "folder", value: query.isEmpty ? shown : MailFolder.all.rawValue)]
        if let accountID { items.append(URLQueryItem(name: "account_id", value: String(accountID))) }
        if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let before, let date = before.listDate {
            // Milliseconds: a whole-second cursor skips mail sharing that second.
            items.append(URLQueryItem(name: "before", value: String(Int64((date.timeIntervalSince1970 * 1000).rounded()))))
            items.append(URLQueryItem(name: "before_id", value: String(before.id)))
        }
        var components = URLComponents()
        components.path = "/api/emails"
        components.queryItems = items
        return components.string ?? "/api/emails?folder=inbox"
    }

    func load() async {
        generation += 1
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            async let accountList: [MailAccount] = api.get("/api/accounts")
            async let sidebar: MailSidebar = api.get("/api/emails/sidebar")
            let page: [EmailSummary] = try await api.get(Self.listPath(folder: folder, label: label, accountID: accountID, query: q, before: nil))
            guard mine == generation else { return }
            emails = page
            hasMore = page.count >= Self.pageSize
            // Accounts only fill the mailbox menu; a failure there shouldn't hide mail.
            accounts = (try? await accountList) ?? accounts
            labels = (try? await sidebar)?.labels ?? labels
            errorMessage = nil
        } catch APIError.unauthorized {
            // AppState signs out.
        } catch {
            guard mine == generation else { return }
            errorMessage = error.localizedDescription
        }
        hasLoaded = true
    }

    func loadMore() async {
        guard hasMore, !isLoadingMore, !isLoading, let last = emails.last else { return }
        let mine = generation
        isLoadingMore = true
        defer { isLoadingMore = false }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let page: [EmailSummary] = try await api.get(Self.listPath(folder: folder, label: label, accountID: accountID, query: q, before: last))
            guard mine == generation else { return }
            let known = Set(emails.map(\.id))
            emails.append(contentsOf: page.filter { !known.contains($0.id) })
            hasMore = page.count >= Self.pageSize
        } catch {
            guard mine == generation else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// The message body, readable. Most stored bodies are sealed to the owner's
    /// end-to-end key: with that key on this phone it opens here, like in the
    /// browser. Otherwise `?live=true` has the server fetch the message from the
    /// mail provider. Returns nil when neither works (no key here and the
    /// provider refetch failed, or a Fluxze-to-Fluxze message).
    func body(of email: EmailSummary) async throws -> String? {
        let stored: EmailBodyResponse = try await api.get("/api/emails/\(email.id)/body")
        let text = stored.body ?? ""
        guard EmailText.isSealed(text) else { return text }
        if let opened = Self.open(text, userID: userID, key: KeyVault.privateKey()) {
            return opened
        }
        let live: EmailBodyResponse = try await api.get("/api/emails/\(email.id)/body?live=true")
        let liveText = live.body ?? ""
        guard EmailText.isSealed(liveText) else { return liveText }
        return Self.open(liveText, userID: userID, key: KeyVault.privateKey())
    }

    /// Opens a sealed body with this phone's key; nil if there's no key or it
    /// isn't the key the body was sealed to.
    static func open(_ text: String, userID: Int?, key: SecKey?) -> String? {
        guard let key else { return nil }
        return try? FluxzeCrypto.openSecure(text, userID: userID, key: key)
    }

    func markRead(_ email: EmailSummary) async {
        guard !email.isRead else { return }
        setRead(email.id, true)
        do {
            let _: Ignored = try await api.post("/api/emails/\(email.id)/read", body: [String: String]())
        } catch {
            setRead(email.id, false)
        }
    }

    /// What's being listed: the label's name, else the folder's.
    var viewTitle: String { label?.name ?? folder.title }

    /// The plain inbox (no label picked).
    var isInbox: Bool { folder == .inbox && label == nil }

    func show(_ folder: MailFolder) {
        self.folder = folder
        label = nil
        Task { await load() }
    }

    func show(_ label: MailLabel) {
        self.label = label
        Task { await load() }
    }

    /// Creates a label in one Gmail mailbox (`POST /api/emails/labels`) and
    /// adds it to the menu.
    func createLabel(named name: String, in accountID: Int) async throws -> MailLabel {
        struct Body: Encodable { let accountId: Int; let name: String }
        let created: MailLabel = try await api.post("/api/emails/labels", body: Body(accountId: accountID, name: name))
        labels = (labels.filter { $0.id != created.id } + [created])
            .sorted { ($0.accountEmail, $0.name.lowercased()) < ($1.accountEmail, $1.name.lowercased()) }
        return created
    }

    func detail(of email: EmailSummary) async throws -> EmailDetail {
        try await api.get("/api/emails/\(email.id)")
    }

    /// "to: a@x.com", or "to: a@x.com, b@x.com +2": the recipients' addresses.
    static func recipientSummary(_ receiver: String?) -> String {
        let addresses = EmailText.splitAddresses(receiver ?? "").map(EmailText.address(of:))
        guard !addresses.isEmpty else { return "to: (no recipient)" }
        let shown = addresses.prefix(2).joined(separator: ", ")
        return addresses.count > 2 ? "to: \(shown) +\(addresses.count - 2)" : "to: \(shown)"
    }

    func account(for id: Int?) -> MailAccount? {
        guard let id else { return nil }
        return accounts.first { $0.id == id }
    }

    // MARK: Actions on one email (the web inbox's, through the same endpoints)

    func isStarred(_ id: Int) -> Bool {
        emails.first { $0.id == id }?.isStarred == true
    }

    /// Stars or unstars it here and at the mail provider; puts it back if refused.
    func setStarred(_ email: EmailSummary, _ starred: Bool) async throws {
        setStar(email.id, starred)
        do {
            let _: Ignored = try await api.post(
                "/api/emails/\(email.id)/\(starred ? "star" : "unstar")", body: [String: String]())
        } catch {
            setStar(email.id, !starred)
            throw error
        }
    }

    func markUnread(_ email: EmailSummary) async throws {
        setRead(email.id, false)
        do {
            let _: Ignored = try await api.post("/api/emails/\(email.id)/unread", body: [String: String]())
        } catch {
            setRead(email.id, true)
            throw error
        }
    }

    /// Moves it to Trash, here and at the mail provider.
    func trash(_ email: EmailSummary) async throws {
        try await api.delete("/api/emails/\(email.id)")
        if folder != .trash { emails.removeAll { $0.id == email.id } }
    }

    /// Brings it back from Trash to the Inbox, here and at the mail provider.
    func restore(_ email: EmailSummary) async throws {
        let _: Ignored = try await api.post("/api/emails/\(email.id)/restore", body: [String: String]())
        if folder == .trash { emails.removeAll { $0.id == email.id } }
    }

    /// Hides it until `until` (Fluxze only; it returns to the top of the Inbox).
    func snooze(_ email: EmailSummary, until: Date) async throws {
        struct Body: Encodable { let until: String }
        let _: Ignored = try await api.post(
            "/api/emails/\(email.id)/snooze",
            body: Body(until: ISO8601DateFormatter().string(from: until)))
        if folder != .snoozed { emails.removeAll { $0.id == email.id } }
    }

    /// The snooze presets, as in Gmail: later today, tomorrow, this weekend
    /// and next week, at 8 am (later today: in three hours, or 6 pm).
    static func snoozeOptions(now: Date = .now, calendar: Calendar = .current) -> [(title: String, date: Date)] {
        func at(_ day: Date, hour: Int) -> Date {
            calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
        }
        var options: [(String, Date)] = []
        let hour = calendar.component(.hour, from: now)
        if hour < 17 {
            options.append(("Later today", hour < 15 ? at(now, hour: 18) : now.addingTimeInterval(3 * 3600)))
        }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) {
            options.append(("Tomorrow", at(tomorrow, hour: 8)))
        }
        let weekday = calendar.component(.weekday, from: now)  // 1 = Sunday … 7 = Saturday
        if weekday != 7, weekday != 1,
           let saturday = calendar.nextDate(after: now, matching: DateComponents(weekday: 7), matchingPolicy: .nextTime) {
            options.append(("This weekend", at(saturday, hour: 8)))
        }
        if let monday = calendar.nextDate(after: now, matching: DateComponents(weekday: 2), matchingPolicy: .nextTime) {
            options.append(("Next week", at(monday, hour: 8)))
        }
        return options
    }

    struct Outgoing: Encodable, Equatable {
        var accountId: Int
        var to: String
        var cc: [String]?
        var subject: String
        var body: String
        /// Reply only: threads it under the original at the recipient.
        var replyToEmailId: Int?
        /// Forward only: the original's stored attachments, sent along.
        var forwardAttachmentIds: [Int]?
    }

    /// Sends through the mailbox it's from (`POST /api/emails`, plain text).
    func send(_ message: Outgoing) async throws {
        let _: Ignored = try await api.post("/api/emails", body: message)
    }

    func attachmentIDs(of email: EmailSummary) async -> [Int] {
        struct Attachment: Decodable { let id: Int }
        let list: [Attachment] = (try? await api.get("/api/emails/\(email.id)/attachments")) ?? []
        return list.map(\.id)
    }

    private func setRead(_ id: Int, _ read: Bool) {
        if let index = emails.firstIndex(where: { $0.id == id }) {
            emails[index].isRead = read
        }
    }

    private func setStar(_ id: Int, _ starred: Bool) {
        if let index = emails.firstIndex(where: { $0.id == id }) {
            emails[index].isStarred = starred
        }
    }
}
