import SwiftUI

/// One conversation: its messages, oldest at the top, and a box to write in.
struct ChatConversationView: View {
    @ObservedObject var store: ChatStore
    let conversation: ChatConversation

    @State private var draft = ""
    @State private var sendError: String?
    @State private var unlocking = false
    @FocusState private var composing: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 6) {
                    if store.isLoadingMessages {
                        ProgressView().padding(.top, 40)
                    } else if store.bubbles.isEmpty {
                        Text("No messages yet. Say hello!")
                            .foregroundStyle(.secondary)
                            .padding(.top, 40)
                    }
                    ForEach(Array(store.bubbles.enumerated()), id: \.element.id) { index, bubble in
                        let previous = index > 0 ? store.bubbles[index - 1] : nil
                        MessageBubble(
                            bubble: bubble,
                            isMine: bubble.senderId == store.myID,
                            // Channels name the sender once per run of messages.
                            showSender: isChannel && previous?.senderId != bubble.senderId,
                            senderLabel: senderLabel(bubble)
                        )
                        .id(bubble.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: store.bubbles.last?.id) { _, last in
                guard let last else { return }
                withAnimation { proxy.scrollTo(last, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.open(conversation) }
        .onDisappear { if store.current == conversation { store.close() } }
        .sheet(isPresented: $unlocking) {
            UnlockKeyView { Task { await store.open(conversation) } }
        }
        .alert("Couldn't send",
               isPresented: Binding(get: { sendError != nil }, set: { if !$0 { sendError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(sendError ?? "")
        }
    }

    /// A DM's name as now known (it may have been looked up since it opened).
    private var title: String {
        if case .dm(let user) = conversation { return store.user(user.id).email }
        return conversation.title
    }

    private var isChannel: Bool {
        if case .channel = conversation { return true }
        return false
    }

    private func senderLabel(_ bubble: ChatBubble) -> String {
        bubble.senderName ?? store.user(bubble.senderId).email
    }

    @ViewBuilder
    private var composer: some View {
        VStack(spacing: 0) {
            Divider()
            if !store.canSend {
                HStack {
                    Label("Messages here are end-to-end encrypted.", systemImage: "lock")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Unlock") { unlocking = true }
                        .font(.footnote.weight(.semibold))
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Message", text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($composing)
                        // Return sends. A hardware keyboard's Return submits;
                        // the on-screen one types a newline into a growing
                        // (vertical) field, which is caught below. Whichever
                        // comes second finds the box empty and does nothing.
                        .submitLabel(.send)
                        .onSubmit(send)
                        .onChange(of: draft) { _, new in
                            guard new.hasSuffix("\n") else { return }
                            draft = String(new.dropLast())
                            send()
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
        .background(.bar)
    }

    private func send() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        // Cleared at once so Return can't send it twice while a key is looked up.
        draft = ""
        // Keep the keyboard up for the next message.
        composing = true
        Task {
            do {
                try await store.send(text)
            } catch {
                draft = text
                sendError = error.localizedDescription
            }
        }
    }
}

private struct MessageBubble: View {
    let bubble: ChatBubble
    let isMine: Bool
    let showSender: Bool
    let senderLabel: String

    var body: some View {
        VStack(alignment: isMine ? .trailing : .leading, spacing: 2) {
            if showSender, !isMine {
                Text(senderLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .padding(.top, 6)
            }
            HStack {
                if isMine { Spacer(minLength: 48) }
                Text(bubble.text)
                    .font(bubble.isReadable ? .body : .callout.italic())
                    .foregroundStyle(isMine ? Color.white : (bubble.isReadable ? Color.primary : Color.secondary))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(isMine ? Color.accentColor : Color(.secondarySystemBackground),
                                in: RoundedRectangle(cornerRadius: 18))
                    .textSelection(.enabled)
                if !isMine { Spacer(minLength: 48) }
            }
            footer
        }
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
    }

    @ViewBuilder
    private var footer: some View {
        switch bubble.state {
        case .sending:
            Text("Sending…").font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 4)
        case .failed:
            Label("Not sent", systemImage: "exclamationmark.circle")
                .font(.caption2).foregroundStyle(.red).padding(.horizontal, 4)
        case .sent:
            if let date = bubble.createdAt {
                Text(date.formatted(date: .omitted, time: .shortened))
                    .font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 4)
            }
        }
    }
}
