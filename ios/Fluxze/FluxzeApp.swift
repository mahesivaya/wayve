import SwiftUI

@main
struct FluxzeApp: App {
    @StateObject private var appState = AppState()
    @AppStorage(AppearanceChoice.storageKey) private var appearance = AppearanceChoice.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                // Settings → Appearance, set on the window itself so it takes
                // effect at once everywhere, including an open sheet.
                .onAppear { Self.apply(appearance) }
                .onChange(of: appearance) { _, new in Self.apply(new) }
        }
    }

    static func apply(_ raw: String) {
        let style: UIUserInterfaceStyle = switch AppearanceChoice(rawValue: raw) ?? .system {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
        for scene in UIApplication.shared.connectedScenes {
            for window in (scene as? UIWindowScene)?.windows ?? [] {
                window.overrideUserInterfaceStyle = style
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Group {
            switch appState.phase {
            case .loading:
                ProgressView()
            case .signedOut:
                LoginView()
            case .signedIn:
                MainTabView(api: appState.api, me: appState.me)
            }
        }
        .task { await appState.restore() }
        .task { await InstallReporter.report(api: appState.api) }
    }
}

/// The signed-in app: a tab per area.
struct MainTabView: View {
    let api: APIClient
    let userID: Int?
    /// Guests never see code, so they get no Reviews tab.
    let canSeeCode: Bool
    /// Held here, not in the Chat tab, so the unread badge and the live
    /// connection work before the tab is opened.
    @StateObject private var chat: ChatStore
    /// Held here so the Inbox tab can show its unread count.
    @StateObject private var emails: EmailsStore

    init(api: APIClient, me: Me?) {
        self.api = api
        userID = me?.id
        canSeeCode = me?.canSeeCode ?? true
        _chat = StateObject(wrappedValue: ChatStore(api: api, me: me))
        _emails = StateObject(wrappedValue: EmailsStore(api: api, userID: me?.id))
    }

    var body: some View {
        // Inbox is the first tab, so the app opens on it.
        TabView {
            EmailListView(store: emails)
                .tabItem { Label("Inbox", systemImage: "tray") }
                .badge(emails.unreadTotal)
            ChatListView(store: chat)
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
                .badge(chat.totalUnread)
            if canSeeCode {
                ReviewsView(store: ReviewsStore(api: api))
                    // GitHub's pull request icon; tab bars draw icons in one tint.
                    .tabItem { Label("Reviews", image: "PullRequest") }
            }
            TaskListView(store: TasksStore(api: api))
                .tabItem { Label("Tasks", systemImage: "checklist") }
            CalendarView(store: MeetingsStore(api: api))
                .tabItem { Label("Calendar", systemImage: "calendar") }
            DriveView(api: api)
                .tabItem { Label("Drive", systemImage: "folder") }
        }
        .task {
            chat.start()
            if !chat.hasLoaded { await chat.load() }
        }
        // Signing out removes this view; the connection goes with it.
        .onDisappear { chat.stop() }
    }
}
