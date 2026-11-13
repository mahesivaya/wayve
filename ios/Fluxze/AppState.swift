import Foundation

@MainActor
final class AppState: ObservableObject {
    enum Phase: Equatable {
        case loading
        case signedOut
        /// `me` is nil when the token is kept but `/api/me` couldn't be reached.
        case signedIn(me: Me?)
    }

    @Published private(set) var phase: Phase = .loading
    /// A one-off message for the sign-in screen, such as "session expired".
    @Published var notice: String?

    let api: APIClient

    init(api: APIClient? = nil) {
        self.api = api ?? APIClient(baseURL: Config.baseURL, token: Keychain.loadToken())
        self.api.onUnauthorized = { [weak self] in
            self?.signOut(notice: "Your session has expired. Please sign in again.")
        }
    }

    var me: Me? {
        if case .signedIn(let me) = phase { return me }
        return nil
    }

    /// On launch: keep the saved session if the server still accepts it.
    func restore() async {
        guard api.token != nil else {
            phase = .signedOut
            return
        }
        await loadMe()
    }

    func signIn(token: String) async {
        Keychain.saveToken(token)
        api.token = token
        notice = nil
        await loadMe()
        // Attach the account to this install for the Analytics page.
        await InstallReporter.report(api: api)
    }

    func signOut(notice: String? = nil) {
        Keychain.deleteToken()
        api.token = nil
        self.notice = notice
        phase = .signedOut
    }

    /// Deletes the account (`DELETE /api/me`). Only personal accounts can do
    /// this; the server explains why otherwise, and that message is thrown.
    func deleteAccount() async throws {
        try await api.delete("/api/me")
        signOut(notice: "Your account has been deleted.")
    }

    private func loadMe() async {
        do {
            let me: Me = try await api.get("/api/me")
            phase = .signedIn(me: me)
        } catch APIError.unauthorized {
            // onUnauthorized already signed out.
            if phase != .signedOut { signOut() }
        } catch {
            phase = .signedIn(me: nil)
        }
    }
}
