import SwiftUI

/// Shown when sign-in returns `email_unverified`: enter the 6-digit code from
/// the verification email, then sign in again.
struct VerifyEmailView: View {
    @EnvironmentObject private var appState: AppState
    let email: String
    let message: String
    let onVerified: () async -> Void

    @State private var code = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var info: String?

    var body: some View {
        Form {
            Section {
                Text(message)
                Text("Enter the 6-digit code we emailed to \(email).")
                    .foregroundStyle(.secondary)
            }
            Section {
                TextField("Verification code", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
            if let info {
                Section { Text(info).foregroundStyle(.secondary) }
            }
            Section {
                Button("Verify and sign in") { Task { await verify() } }
                    .disabled(code.trimmingCharacters(in: .whitespaces).count < 6 || isWorking)
                Button("Send a new code") { Task { await resend() } }
                    .disabled(isWorking)
            }
        }
        .navigationTitle("Verify your email")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func verify() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await AuthService(api: appState.api).verifyEmail(email: email, code: code)
            await onVerified()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resend() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await AuthService(api: appState.api).resendVerification(email: email)
            info = "If that address needs verifying, a new code is on its way."
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
