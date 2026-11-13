import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var isDeleting = false
    @State private var errorMessage: String?
    @State private var hasKey = KeyVault.hasKey
    @State private var unlocking = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    if let me = appState.me {
                        LabeledContent("Email", value: me.email)
                        if let username = me.username, !username.isEmpty {
                            LabeledContent("Username", value: username)
                        }
                    }
                    Button("Sign out") { confirmSignOut = true }
                }

                Section {
                    if hasKey {
                        Label("Unlocked on this iPhone", systemImage: "lock.open")
                        Button("Remove key from this iPhone", role: .destructive) {
                            KeyVault.delete()
                            hasKey = false
                        }
                    } else {
                        Label("Locked on this iPhone", systemImage: "lock")
                        Button("Unlock with recovery phrase") { unlocking = true }
                    }
                } header: {
                    Text("Encrypted mail")
                } footer: {
                    Text("With your key on this iPhone, encrypted mail opens here like it does in your browser. The key stays on this device and is removed when you sign out.")
                }

                Section {
                    Link("Open Fluxze on the web", destination: Config.webURL("/"))
                    Link("Privacy policy", destination: Config.webURL("/privacy"))
                }

                Section {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        if isDeleting { ProgressView() } else { Text("Delete account") }
                    }
                    .disabled(isDeleting)
                } footer: {
                    Text("Permanently deletes your Fluxze account and its data. Organization accounts are managed by their organization.")
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                Section {
                    LabeledContent("Version", value: Bundle.main.appVersion)
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(isPresented: $unlocking) {
                UnlockKeyView { hasKey = true }
            }
            .confirmationDialog("Sign out of Fluxze?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { appState.signOut() }
            }
            .alert("Delete your account?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) { Task { await deleteAccount() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently deletes your account, tasks and other data. It can't be undone.")
            }
        }
    }

    private func deleteAccount() async {
        isDeleting = true
        errorMessage = nil
        defer { isDeleting = false }
        do {
            try await appState.deleteAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

extension Bundle {
    var appVersion: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
