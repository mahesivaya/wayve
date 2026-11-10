import Foundation

enum Config {
    static let productionURL = URL(string: "https://fluxze.com")!

    /// The server the app talks to. Always production in a Release build. A
    /// Debug build can be pointed at the local dev stack with the launch
    /// argument `-FluxzeBaseURL http://localhost`.
    static var baseURL: URL {
        #if DEBUG
        if let override = UserDefaults.standard.string(forKey: "FluxzeBaseURL"),
           let url = URL(string: override) {
            return url
        }
        #endif
        return productionURL
    }

    static func webURL(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL)?.absoluteURL ?? productionURL
    }
}
