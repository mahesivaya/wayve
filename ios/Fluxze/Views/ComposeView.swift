import SwiftUI

/// Write a new email, or reply to or forward one, sent as plain text: a reply
/// or forward from the mailbox the original came to, a new email from the
/// mailbox picked under From.
struct ComposeView: View {
    enum Mode {
        case new
        case reply
        case forward
    }

    @ObservedObject var store: EmailsStore
    /// The email being replied to or forwarded; nil for a new email.
    let original: EmailSummary?
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
    /// A new email's mailbox; a reply or forward uses the original's.
    @State private var fromAccountID: Int?
    @FocusState private var focus: Field?

    private enum Field { case to, message }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if mode == .new {
                        Picker("From", selection: $fromAccountID) {
                            ForEach(store.accounts) { account in
                                Text(account.email).tag(Int?.some(account.id))
                            }
                        }
                    } else if let from = store.account(for: original?.accountId)?.email {
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
            .navigationTitle(mode == .new ? "New email" : mode == .reply ? "Reply" : "Forward")
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

    private var sendingAccountID: Int? {
        mode == .new ? fromAccountID : original?.accountId
    }

    private var canSend: Bool {
        !to.trimmingCharacters(in: .whitespaces).isEmpty
            && !subject.trimmingCharacters(in: .whitespaces).isEmpty
            && sendingAccountID != nil
    }

    private func prefill() {
        if mode == .new {
            if fromAccountID == nil {
                // The mailbox the inbox is filtered to, else the first one.
                fromAccountID = store.accountID ?? store.accounts.first?.id
                focus = .to
            }
            return
        }
        guard subject.isEmpty, let original else { return }
        let base = original.displaySubject
        switch mode {
        case .new:
            break
        case .reply:
            to = Self.replyAddress(original, mailbox: store.account(for: original.accountId)?.email)
            subject = Self.prefixed(base, "Re:")
            focus = .message
        case .forward:
            subject = Self.prefixed(base, "Fwd:")
            focus = .to
        }
    }

    /// Who a reply goes to: the sender, unless the sender is this mailbox (an
    /// email you sent), in which case it's the people you sent it to.
    static func replyAddress(_ original: EmailSummary, mailbox: String?) -> String {
        let sender = original.sender.map(EmailText.address(of:)) ?? ""
        guard let mailbox, !sender.isEmpty,
              sender.caseInsensitiveCompare(mailbox) == .orderedSame else { return sender }
        let recipients = EmailText.splitAddresses(original.receiver ?? "").map(EmailText.address(of:))
        return recipients.isEmpty ? sender : recipients.joined(separator: ", ")
    }

    /// "Re: Hello", without stacking "Re: Re:".
    static func prefixed(_ subject: String, _ prefix: String) -> String {
        subject.lowercased().hasPrefix(prefix.lowercased()) ? subject : "\(prefix) \(subject)"
    }

    /// The text that goes out: the new message, then the original, quoted for a
    /// reply and set off with a header for a forward.
    static func outgoingBody(_ message: String, mode: Mode, original: EmailSummary?, originalText: String?) -> String {
        guard let original, let originalText, !originalText.isEmpty else { return message }
        let when = (original.createdAt ?? original.listDate)?
            .formatted(date: .abbreviated, time: .shortened) ?? ""
        let from = original.sender ?? ""
        switch mode {
        case .new:
            return message
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
        guard let accountID = sendingAccountID else { return }
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
        switch (mode, original) {
        case (.reply, let original?):
            outgoing.replyToEmailId = original.id
        case (.forward, let original?):
            let ids = await store.attachmentIDs(of: original)
            outgoing.forwardAttachmentIds = ids.isEmpty ? nil : ids
        default:
            break
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
