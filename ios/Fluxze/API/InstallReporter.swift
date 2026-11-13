import Foundation
import UIKit

/// Tells the server this install exists (`POST /api/mobile/installs`), so the
/// platform Analytics page can count installs: the App Store doesn't tell us.
///
/// The install id is a random UUID made on first launch and kept in
/// UserDefaults, which iOS wipes when the app is deleted, so a reinstall counts
/// as a new install. It identifies the install, not the person. Sent on every
/// launch (and after sign-in, to attach the account); failures are ignored.
@MainActor
enum InstallReporter {
    static let installIDKey = "FluxzeInstallID"

    struct Report: Encodable, Equatable {
        let installId: String
        let platform: String
        let channel: String
        let appVersion: String?
        let build: String?
        let osVersion: String
        let deviceModel: String
    }

    static func installID(defaults: UserDefaults = .standard) -> String {
        if let id = defaults.string(forKey: installIDKey), UUID(uuidString: id) != nil {
            return id
        }
        let id = UUID().uuidString
        defaults.set(id, forKey: installIDKey)
        return id
    }

    /// `debug` for Xcode builds; TestFlight builds carry a sandbox receipt.
    static var channel: String {
        #if DEBUG
        return "debug"
        #else
        return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
            ? "testflight" : "app_store"
        #endif
    }

    /// The hardware id, such as `iPhone16,2`; "Mac" for the iPhone app on a Mac.
    static var deviceModel: String {
        if ProcessInfo.processInfo.isiOSAppOnMac { return "Mac" }
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated
        }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    static func makeReport(defaults: UserDefaults = .standard, bundle: Bundle = .main) -> Report {
        Report(
            installId: installID(defaults: defaults),
            platform: "ios",
            channel: channel,
            appVersion: bundle.infoDictionary?["CFBundleShortVersionString"] as? String,
            build: bundle.infoDictionary?["CFBundleVersion"] as? String,
            osVersion: UIDevice.current.systemVersion,
            deviceModel: deviceModel
        )
    }

    static func report(api: APIClient) async {
        do {
            let _: Ignored = try await api.post("/api/mobile/installs", body: makeReport())
        } catch {
            // Best-effort: the next launch reports again.
        }
    }
}
