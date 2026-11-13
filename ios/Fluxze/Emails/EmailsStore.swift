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
    static func listPath(folder: MailFolder, accountID: Int?, query: String, before: EmailSummary?) -> String {
        var items = [URLQueryItem(name: "folder", value: query.isEmpty ? folder.rawValue : MailFolder.all.rawValue)]
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
            let page: [EmailSummary] = try await api.get(Self.listPath(folder: folder, accountID: accountID, query: q, before: nil))
            guard mine == generation else { return }
            emails = page
            hasMore = page.count >= Self.pageSize
            // Accounts only fill the mailbox menu; a failure there shouldn't hide mail.
            accounts = (try? await accountList) ?? accounts
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
            let page: [EmailSummary] = try await api.get(Self.listPath(folder: folder, accountID: accountID, query: q, before: last))
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

    private func setRead(_ id: Int, _ read: Bool) {
        if let index = emails.firstIndex(where: { $0.id == id }) {
            emails[index].isRead = read
        }
    }
}
