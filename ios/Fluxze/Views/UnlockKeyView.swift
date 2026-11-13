import SwiftUI

/// Unlocks the end-to-end key on this phone with the 24-word recovery phrase,
/// the same way the web app restores it on a new browser: the phrase unlocks
/// the recovery copy at `GET /api/me/wrapped-key`. The phrase stays on the
/// phone and is never stored.
struct UnlockKeyView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    /// Called after the key is saved, e.g. to reopen the message.
    var onUnlocked: () -> Void = {}

    @State private var phrase = ""
    @State private var isWorking = false
    @State private var errorMessage: String?

    private var wordCount: Int { RecoveryPhrase.words(in: phrase).count }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("24-word recovery phrase", text: $phrase, axis: .vertical)
                        .lineLimit(4...8)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("Recovery phrase")
                } footer: {
                    Text("\(wordCount) of 24 words. Enter the phrase you saved when you set up Fluxze, with spaces between words. It unlocks your encrypted mail on this iPhone and isn't stored.")
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                Section {
                    Button {
                        Task { await unlock() }
                    } label: {
                        HStack {
                            Spacer()
                            if isWorking { ProgressView() } else { Text("Unlock").bold() }
                            Spacer()
                        }
                    }
                    .disabled(wordCount != 24 || isWorking)
                } footer: {
                    Text("Organization accounts unlock automatically when you sign in with your password.")
                }
            }
            .navigationTitle("Unlock encrypted mail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func unlock() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let entropy = try RecoveryPhrase.entropy(from: phrase)
            let envelope: FluxzeCrypto.RecoveryEnvelope
            do {
                envelope = try await appState.api.get("/api/me/wrapped-key")
            } catch APIError.server(status: 404, _, _) {
                errorMessage = "Your account has no recovery copy of its key on Fluxze, so it can only be unlocked in the browser that holds it."
                return
            }
            // 600k PBKDF2 rounds: keep it off the main thread.
            let pkcs8 = try await Task.detached(priority: .userInitiated) {
                try FluxzeCrypto.unwrapRecovery(envelope, entropy: entropy)
            }.value
            try KeyVault.save(pkcs8: pkcs8)
            phrase = ""
            onUnlocked()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
