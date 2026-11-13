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
                MainTabView(api: appState.api)
            }
        }
        .task { await appState.restore() }
        .task { await InstallReporter.report(api: appState.api) }
    }
}

/// The signed-in app: a tab per area.
struct MainTabView: View {
    let api: APIClient

    var body: some View {
        TabView {
            EmailListView(store: EmailsStore(api: api))
                .tabItem { Label("Email", systemImage: "envelope") }
            TaskListView(store: TasksStore(api: api))
                .tabItem { Label("Tasks", systemImage: "checklist") }
            CalendarView(store: MeetingsStore(api: api))
                .tabItem { Label("Calendar", systemImage: "calendar") }
        }
    }
}
