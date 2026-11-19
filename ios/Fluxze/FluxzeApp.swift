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

/// The signed-in app: a dock of up to four areas, and a ⋯ tab that opens a
/// menu with the rest, Settings and Customize dock.
struct MainTabView: View {
    let api: APIClient
    let userID: Int?
    /// Guests never see code, so they get no Reviews area.
    let canSeeCode: Bool
    /// Held here, not in the Chat tab, so the unread badge and the live
    /// connection work before the tab is opened.
    @StateObject private var chat: ChatStore
    /// Held here so the Inbox tab can show its unread count.
    @StateObject private var emails: EmailsStore
    @AppStorage(Dock.storageKey) private var storedDock = ""
    @State private var selection: DockTab
    /// The area picked from the ⋯ menu, shown in the ⋯ tab.
    @State private var moreArea: AppArea?
    @State private var sheet: MoreSheet?

    enum DockTab: Hashable {
        case area(AppArea)
        case more
    }

    enum MoreSheet: String, Identifiable {
        case menu, settings, customize
        var id: String { rawValue }
    }

    init(api: APIClient, me: Me?) {
        self.api = api
        userID = me?.id
        let canSeeCode = me?.canSeeCode ?? true
        self.canSeeCode = canSeeCode
        _chat = StateObject(wrappedValue: ChatStore(api: api, me: me))
        _emails = StateObject(wrappedValue: EmailsStore(api: api, userID: me?.id))
        // The app opens on the dock's first area (Inbox, unless it was moved).
        let first = Dock.areas(
            stored: UserDefaults.standard.string(forKey: Dock.storageKey) ?? "",
            available: Self.available(canSeeCode: canSeeCode)).first
        _selection = State(initialValue: .area(first ?? .inbox))
    }

    static func available(canSeeCode: Bool) -> [AppArea] {
        AppArea.allCases.filter { $0 != .reviews || canSeeCode }
    }

    private var available: [AppArea] { Self.available(canSeeCode: canSeeCode) }
    private var dock: [AppArea] { Dock.areas(stored: storedDock, available: available) }
    private var overflow: [AppArea] { available.filter { !dock.contains($0) } }

    var body: some View {
        // Tapping ⋯ opens its menu instead of switching to it; the tab is only
        // shown once an area is picked there.
        TabView(selection: Binding(
            get: { selection },
            set: { new in if new == .more { sheet = .menu } else { selection = new } }
        )) {
            ForEach(dock) { area in
                view(for: area)
                    .tabItem { area.label }
                    .badge(badge(for: area))
                    .tag(DockTab.area(area))
            }
            Group {
                if let moreArea { view(for: moreArea) } else { Color.clear }
            }
            .tabItem { Label("More", systemImage: "ellipsis") }
            .badge(overflow.reduce(0) { $0 + badge(for: $1) })
            .tag(DockTab.more)
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .menu:
                MoreMenu(
                    areas: overflow,
                    onPick: { area in
                        moreArea = area
                        selection = .more
                        sheet = nil
                    },
                    onSettings: { sheet = .settings },
                    onCustomize: { sheet = .customize })
            case .settings:
                SettingsView()
            case .customize:
                CustomizeDockView(available: available, stored: $storedDock)
            }
        }
        .onChange(of: storedDock) { _, _ in keepSelectionValid() }
        .task {
            chat.start()
            if !chat.hasLoaded { await chat.load() }
        }
        // Signing out removes this view; the connection goes with it.
        .onDisappear { chat.stop() }
    }

    @ViewBuilder
    private func view(for area: AppArea) -> some View {
        switch area {
        case .inbox: EmailListView(store: emails)
        case .chat: ChatListView(store: chat)
        case .reviews: ReviewsView(store: ReviewsStore(api: api))
        case .tasks: TaskListView(store: TasksStore(api: api))
        case .calendar: CalendarView(store: MeetingsStore(api: api))
        case .drive: DriveView(api: api)
        }
    }

    private func badge(for area: AppArea) -> Int {
        switch area {
        case .inbox: emails.unreadTotal
        case .chat: chat.totalUnread
        default: 0
        }
    }

    /// After the dock changes, stay on the area being shown, wherever it now is.
    private func keepSelectionValid() {
        switch selection {
        case .area(let area) where !dock.contains(area):
            moreArea = area
            selection = .more
        case .more:
            if let moreArea, dock.contains(moreArea) {
                selection = .area(moreArea)
                self.moreArea = nil
            }
        default:
            break
        }
    }
}
