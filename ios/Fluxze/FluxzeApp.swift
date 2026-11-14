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
                MainTabView(api: appState.api, userID: appState.me?.id)
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

    var body: some View {
        TabView {
            HomeView(api: api, userID: userID)
                .tabItem { Label("Home", systemImage: "house") }
            EmailListView(store: EmailsStore(api: api, userID: userID))
                .tabItem { Label("Inbox", systemImage: "tray") }
            TaskListView(store: TasksStore(api: api))
                .tabItem { Label("Tasks", systemImage: "checklist") }
            CalendarView(store: MeetingsStore(api: api))
                .tabItem { Label("Calendar", systemImage: "calendar") }
            DriveView(api: api)
                .tabItem { Label("Drive", systemImage: "folder") }
        }
    }
}
