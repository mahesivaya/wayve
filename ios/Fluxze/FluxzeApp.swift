import SwiftUI

@main
struct FluxzeApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
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
