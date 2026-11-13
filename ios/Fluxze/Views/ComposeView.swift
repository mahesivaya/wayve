import SwiftUI

/// Reply to or forward an email, sent as plain text from the mailbox it came
/// to, like the web app's reply box.
struct ComposeView: View {
    enum Mode {
        case reply
        case forward
    }

    @ObservedObject var store: EmailsStore
    let original: EmailSummary
    let mode: Mode
    /// The original's readable text, quoted below the new message.
    let originalText: String?
    var onSent: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var to = ""
    @State private var cc = ""
    @State private var subject = ""
    @State private var message = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @FocusState private var focus: Field?

    private enum Field { case to, message }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let from = store.account(for: original.accountId)?.email {
                        LabeledContent("From", value: from)
                    }
                    TextField("To", text: $to)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .to)
                    TextField("Cc", text: $cc)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Subject", text: $subject)
                }
                Section {
                    TextField("Message", text: $message, axis: .vertical)
                        .lineLimit(6...)
                        .focused($focus, equals: .message)
                } footer: {
                    if originalText != nil {
                        Text(mode == .reply
                             ? "The original message is quoted below your reply."
                             : "The original message and its attachments are included.")
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle(mode == .reply ? "Reply" : "Forward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSending {
                        ProgressView()
                    } else {
                        Button("Send") { Task { await send() } }
                            .disabled(!canSend)
                    }
                }
            }
            .onAppear(perform: prefill)
        }
        .interactiveDismissDisabled(isSending)
    }

    private var canSend: Bool {
        !to.trimmingCharacters(in: .whitespaces).isEmpty
            && !subject.trimmingCharacters(in: .whitespaces).isEmpty
            && original.accountId != nil
    }

    private func prefill() {
        guard subject.isEmpty else { return }
        let base = original.displaySubject
        switch mode {
        case .reply:
            to = original.sender.map(EmailText.address(of:)) ?? ""
            subject = Self.prefixed(base, "Re:")
            focus = .message
        case .forward:
            subject = Self.prefixed(base, "Fwd:")
            focus = .to
        }
    }

    /// "Re: Hello", without stacking "Re: Re:".
    static func prefixed(_ subject: String, _ prefix: String) -> String {
        subject.lowercased().hasPrefix(prefix.lowercased()) ? subject : "\(prefix) \(subject)"
    }

    /// The text that goes out: the new message, then the original, quoted for a
    /// reply and set off with a header for a forward.
    static func outgoingBody(_ message: String, mode: Mode, original: EmailSummary, originalText: String?) -> String {
        guard let originalText, !originalText.isEmpty else { return message }
        let when = (original.createdAt ?? original.listDate)?
            .formatted(date: .abbreviated, time: .shortened) ?? ""
        let from = original.sender ?? ""
        switch mode {
        case .reply:
            let quoted = originalText
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { "> \($0)" }
                .joined(separator: "\n")
            return "\(message)\n\nOn \(when), \(from) wrote:\n\(quoted)"
        case .forward:
            return """
            \(message)

            ---------- Forwarded message ---------
            From: \(from)
            Date: \(when)
            Subject: \(original.displaySubject)
            To: \(original.receiver ?? "")

            \(originalText)
            """
        }
    }

    private func send() async {
        guard let accountID = original.accountId else { return }
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        let ccList = EmailText.splitAddresses(cc).map(EmailText.address(of:))
        var outgoing = EmailsStore.Outgoing(
            accountId: accountID,
            to: to.trimmingCharacters(in: .whitespaces),
            cc: ccList.isEmpty ? nil : ccList,
            subject: subject.trimmingCharacters(in: .whitespaces),
            body: Self.outgoingBody(message, mode: mode, original: original, originalText: originalText)
        )
        switch mode {
        case .reply: outgoing.replyToEmailId = original.id
        case .forward:
            let ids = await store.attachmentIDs(of: original)
            outgoing.forwardAttachmentIds = ids.isEmpty ? nil : ids
        }
        do {
            try await store.send(outgoing)
            onSent()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
