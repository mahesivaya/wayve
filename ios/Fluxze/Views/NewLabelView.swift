import SwiftUI

/// Create a Gmail label (☰ → Labels → New label). Nest it under another label
/// with "/", as in Gmail ("Clients/Acme").
struct NewLabelView: View {
    @ObservedObject var store: EmailsStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var accountID: Int?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var nameFocused: Bool

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Label name", text: $name)
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                } footer: {
                    Text("Use “/” to put it under another label, like Clients/Acme.")
                }
                if store.accounts.count > 1 {
                    Picker("Mailbox", selection: $accountID) {
                        ForEach(store.accounts) { account in
                            Text(account.email).tag(Int?.some(account.id))
                        }
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("New label")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Create") { Task { await save() } }
                            .disabled(trimmed.isEmpty || accountID == nil)
                    }
                }
            }
            .onAppear {
                accountID = accountID ?? store.accountID ?? store.accounts.first?.id
                nameFocused = true
            }
        }
        .presentationDetents([.medium])
    }

    private func save() async {
        guard let accountID, !trimmed.isEmpty, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let label = try await store.createLabel(named: trimmed, in: accountID)
            store.show(label)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
