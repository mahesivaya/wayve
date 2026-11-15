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
                        HStack(spacing: 10) {
                            statusMenu
                            // Live messages arrive over this connection.
                            if store.hasLoaded, !store.isConnected {
                                Label("Connecting…", systemImage: "wifi.exclamationmark")
                                    .labelStyle(.titleAndIcon)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
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

    /// Your status, as on the web and desktop: Active, Do Not Disturb or Away.
    private var statusMenu: some View {
        let mine = ChatPresence(online: true, lastSeen: nil, status: store.myStatus)
        return Menu {
            Section("Your status") {
                ForEach(Self.statuses, id: \.value) { option in
                    Button {
                        Task { await store.setMyStatus(option.value) }
                    } label: {
                        if option.value == store.myStatus {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                PresenceDot(presence: mine, size: 10)
                Text(mine.label)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
            }
        }
        .accessibilityLabel("Your status: \(mine.label)")
    }

    static let statuses: [(value: String, label: String)] = [
        ("active", "Active"), ("dnd", "Do Not Disturb"), ("away", "Away"),
    ]

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
                                    when: store.lastActivity(conversation),
                                    presence: store.presence(for: conversation))
                }
            }
            .listStyle(.plain)
        }
    }
}

struct ConversationRow: View {
    let conversation: ChatConversation
    let unread: Int
    let when: Date?
    /// A DM's person's presence; nil for channels and while unknown.
    let presence: ChatPresence?

    var body: some View {
        // Name and last-message time on top; under them the person's status
        // (matching the dot), or for a channel, nothing more.
        HStack(spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(conversation.title)
                        .font(.body.weight(unread > 0 ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let when {
                        Text(Self.timeLabel(when))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Last message \(when.formatted(.relative(presentation: .named)))")
                    }
                }
                HStack {
                    if let presence {
                        Text(presence.line())
                            .font(.caption)
                            .foregroundStyle(presence.kind == .offline ? .secondary : PresenceDot.color(presence.kind))
                            .lineLimit(1)
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
            }
        }
        .padding(.vertical, 2)
    }

    /// Like Messages: a time today, "Yesterday", a weekday this week, else a date.
    static func timeLabel(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(date: .numeric, time: .omitted)
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
                // Active, away, do not disturb or offline, on the corner.
                .overlay(alignment: .bottomTrailing) {
                    if let presence { PresenceDot(presence: presence).offset(x: 2, y: 2) }
                }
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

/// The web's presence dot: green active, amber away, red do not disturb,
/// grey offline (offline wins over the chosen status).
struct PresenceDot: View {
    let presence: ChatPresence
    var size: CGFloat = 12

    var body: some View {
        Circle()
            .fill(Self.color(presence.kind))
            .frame(width: size, height: size)
            // A ring in the background colour so it reads on the avatar.
            .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
            .accessibilityLabel(presence.label)
    }

    static func color(_ kind: ChatPresence.Kind) -> Color {
        switch kind {
        case .active: Color(red: 0x15 / 255, green: 0x80 / 255, blue: 0x3d / 255)
        case .away: Color(red: 0xd9 / 255, green: 0x77 / 255, blue: 0x06 / 255)
        case .dnd: Color(red: 0xdc / 255, green: 0x26 / 255, blue: 0x26 / 255)
        case .offline: Color(red: 0xcb / 255, green: 0xd5 / 255, blue: 0xe1 / 255)
        }
    }
}
