import Foundation

private struct PreloginBody: Encodable { let email: String }
private struct PreloginResponse: Decodable {
    let scheme: Int
    let authSalt: String?
}

private struct LoginBody: Encodable {
    let email: String
    var password: String?
    var authKey: String?
}

private struct LoginResponse: Decodable {
    let token: String
    /// Org and platform members: their private key locked under the password.
    let loginWrap: FluxzeCrypto.LoginWrap?
}

private struct EmailBody: Encodable { let email: String }
private struct VerifyBody: Encodable {
    let email: String
    let code: String
}

enum LoginOutcome: Equatable {
    case signedIn(token: String)
    /// The account exists but its email isn't verified yet (403 email_unverified).
    case emailUnverified(message: String)
}

/// Password sign-in, mirroring the web's two-step flow (`Login.tsx`):
/// `POST /api/auth/prelogin` tells which scheme the account uses, then
/// `POST /api/login` gets a derived `auth_key` (scheme 2) or, for a legacy
/// scheme-1 account, the password. The scheme upgrade is left to the web app.
@MainActor
struct AuthService {
    let api: APIClient

    func login(identifier: String, password: String) async throws -> LoginOutcome {
        let email = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        let prelogin: PreloginResponse = try await api.post(
            "/api/auth/prelogin", body: PreloginBody(email: email))

        var body = LoginBody(email: email)
        if prelogin.scheme == 2, let salt = prelogin.authSalt {
            // 600k PBKDF2 rounds: keep it off the main thread.
            body.authKey = try await Task.detached(priority: .userInitiated) {
                try AuthKey.derive(password: password, saltBase64: salt)
            }.value
        } else {
            body.password = password
        }

        do {
            let response: LoginResponse = try await api.post("/api/login", body: body)
            if let wrap = response.loginWrap {
                await Self.unlockKey(wrap, password: password)
            }
            return .signedIn(token: response.token)
        } catch let error as APIError where error.code == "email_unverified" {
            return .emailUnverified(message: error.errorDescription ?? "Please verify your email.")
        }
    }

    /// Unlocks the end-to-end key with the password just typed, as the web app
    /// does at login, so encrypted mail opens on this phone. Best-effort: a
    /// failure leaves the key locked (the recovery phrase can still unlock it)
    /// and never blocks signing in.
    static func unlockKey(_ wrap: FluxzeCrypto.LoginWrap, password: String) async {
        let pkcs8 = await Task.detached(priority: .userInitiated) {
            try? FluxzeCrypto.unwrapLoginWrap(wrap, password: password)
        }.value
        if let pkcs8 { try? KeyVault.save(pkcs8: pkcs8) }
    }

    func verifyEmail(email: String, code: String) async throws {
        let _: Ignored = try await api.post(
            "/api/verify-email",
            body: VerifyBody(email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                             code: code.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    func resendVerification(email: String) async throws {
        let _: Ignored = try await api.post(
            "/api/resend-verification",
            body: EmailBody(email: email.trimmingCharacters(in: .whitespacesAndNewlines)))
    }
}
