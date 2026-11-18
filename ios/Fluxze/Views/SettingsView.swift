import SwiftUI

/// Settings, opened from the account button: a list of pages, each opening
/// with ›, and Sign out at the end.
struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Personal") {
                    NavigationLink { AccountSettingsView() } label: {
                        Label("Account", systemImage: "person")
                    }
                    NavigationLink { AppearanceSettingsView() } label: {
                        Label("Appearance", systemImage: "circle.lefthalf.filled")
                    }
                    NavigationLink { EncryptionSettingsView() } label: {
                        Label("Encrypted mail", systemImage: "lock")
                    }
                }

                Section("About") {
                    Link(destination: Config.webURL("/")) {
                        LinkRow(title: "Hadal on the web", systemImage: "globe")
                    }
                    Link(destination: Config.webURL("/privacy")) {
                        LinkRow(title: "Privacy policy", systemImage: "hand.raised")
                    }
                    LabeledContent {
                        Text(Bundle.main.appVersion)
                    } label: {
                        Label("Version", systemImage: "info.circle")
                    }
                }

                Section {
                    Button("Sign out") { appState.signOut() }
                        .frame(maxWidth: .infinity)
                }
            }
            .tint(.primary)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
    }
}

/// A row that leaves the app, marked with ↗ instead of ›.
private struct LinkRow: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer()
            Image(systemName: "arrow.up.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .foregroundStyle(.primary)
    }
}

/// Who you're signed in as, and deleting the account.
struct AccountSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var confirmDelete = false
    @State private var isDeleting = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            if let me = appState.me {
                Section {
                    LabeledContent("Email", value: me.email)
                    if let username = me.username, !username.isEmpty {
                        LabeledContent("Username", value: username)
                    }
                }
            }

            Section {
                Button(role: .destructive) { confirmDelete = true } label: {
                    if isDeleting { ProgressView() } else { Text("Delete account") }
                }
                .disabled(isDeleting)
            } footer: {
                Text("Permanently deletes your Hadal account and its data. Organization accounts are managed by their organization.")
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Delete your account?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await deleteAccount() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes your account, tasks and other data. It can't be undone.")
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

/// Light, dark, or follow the phone. Applied app-wide in `FluxzeApp`.
enum AppearanceChoice: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "appearance"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}

struct AppearanceSettingsView: View {
    @AppStorage(AppearanceChoice.storageKey) private var appearance = AppearanceChoice.system.rawValue

    var body: some View {
        Form {
            Section {
                Picker("Appearance", selection: $appearance) {
                    ForEach(AppearanceChoice.allCases) { choice in
                        Text(choice.title).tag(choice.rawValue)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } footer: {
                Text("System follows your iPhone's light or dark setting.")
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Whether the end-to-end key is on this phone, and unlocking or removing it.
struct EncryptionSettingsView: View {
    @State private var hasKey = KeyVault.hasKey
    @State private var unlocking = false

    var body: some View {
        Form {
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
            } footer: {
                Text("With your key on this iPhone, encrypted mail opens here like it does in your browser. The key stays on this device and is removed when you sign out.")
            }
        }
        .navigationTitle("Encrypted mail")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $unlocking) {
            UnlockKeyView { hasKey = true }
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
