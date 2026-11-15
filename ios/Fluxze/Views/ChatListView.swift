import SwiftUI

/// The Chat tab: your direct messages and channels, most recent first, as in
/// the web chat's sidebar. Opening one shows its messages.
struct ChatListView: View {
    @ObservedObject var store: ChatStore
    @State private var showingSettings = false
    @State private var startingChat = false
    @State private var path: [ChatConversation] = []

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .refreshable { await store.load() }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        // Live messages arrive over this connection.
                        if store.hasLoaded, !store.isConnected {
                            Label("Connecting…", systemImage: "wifi.exclamationmark")
                                .labelStyle(.titleAndIcon)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { startingChat = true } label: { Image(systemName: "square.and.pencil") }
                            .accessibilityLabel("New chat")
                            .disabled(!store.hasLoaded)
                    }
                    if #available(iOS 26.0, *) {
                        ToolbarSpacer(.fixed, placement: .topBarTrailing)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                }
                .sheet(isPresented: $showingSettings) { SettingsView() }
                .sheet(isPresented: $startingChat) {
                    NewChatView(store: store) { user in path = [.dm(user)] }
                }
                .navigationDestination(for: ChatConversation.self) { conversation in
                    ChatConversationView(store: store, conversation: conversation)
                }
        }
        .task {
            store.start()
            if !store.hasLoaded { await store.load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if !store.hasLoaded {
            ProgressView()
        } else if store.conversations.isEmpty, let error = store.errorMessage {
            ContentUnavailableView {
                Label("Couldn't load chat", systemImage: "wifi.exclamationmark")
            } description: {
                Text(error)
            } actions: {
                Button("Try again") { Task { await store.load() } }
            }
        } else if store.conversations.isEmpty {
            ContentUnavailableView {
                Label("No conversations yet", systemImage: "bubble.left.and.bubble.right")
            } description: {
                Text("Start a chat with someone in your directory.")
            } actions: {
                Button("New chat") { startingChat = true }
            }
        } else {
            List(store.conversations) { conversation in
                NavigationLink(value: conversation) {
                    ConversationRow(conversation: conversation,
                                    unread: store.unread(conversation),
                                    when: store.lastActivity(conversation))
                }
            }
            .listStyle(.plain)
        }
    }
}

private struct ConversationRow: View {
    let conversation: ChatConversation
    let unread: Int
    let when: Date?

    var body: some View {
        HStack(spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.title)
                    .font(.body.weight(unread > 0 ? .semibold : .regular))
                    .lineLimit(1)
                if let when {
                    Text(when.formatted(.relative(presentation: .named)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if unread > 0 {
                Text("\(unread)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.accentColor, in: Capsule())
                    .accessibilityLabel("\(unread) unread")
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var avatar: some View {
        switch conversation {
        case .dm(let user):
            Text(String(user.email.prefix(1)).uppercased())
                .font(.headline)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Color.accentColor.opacity(0.85), in: Circle())
        case .channel:
            Image(systemName: "number")
                .font(.headline)
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .background(Color(.secondarySystemBackground), in: Circle())
        }
    }
}

/// Pick someone from the directory to message.
struct NewChatView: View {
    @ObservedObject var store: ChatStore
    var onPick: (ChatUser) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var matches: [ChatUser] {
        let q = search.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? store.directory : store.directory.filter { $0.email.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        NavigationStack {
            List(matches) { user in
                Button {
                    dismiss()
                    onPick(user)
                } label: {
                    Text(user.email).foregroundStyle(.primary)
                }
            }
            .overlay {
                if matches.isEmpty {
                    ContentUnavailableView(search.isEmpty ? "No one to message yet" : "No matches",
                                           systemImage: "person.crop.circle.badge.questionmark")
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search people")
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}
