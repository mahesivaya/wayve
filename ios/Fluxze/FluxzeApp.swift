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
                TaskListView(store: TasksStore(api: appState.api))
            }
        }
        .task { await appState.restore() }
    }
}
