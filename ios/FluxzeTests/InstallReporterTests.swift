import XCTest
@testable import Fluxze

@MainActor
final class InstallReporterTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "InstallReporterTests"

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testInstallIDIsCreatedOnceAndKept() {
        let first = InstallReporter.installID(defaults: defaults)
        XCTAssertNotNil(UUID(uuidString: first))
        XCTAssertEqual(InstallReporter.installID(defaults: defaults), first)
    }

    func testAMangledStoredIDIsReplaced() {
        defaults.set("garbage", forKey: InstallReporter.installIDKey)
        let id = InstallReporter.installID(defaults: defaults)
        XCTAssertNotNil(UUID(uuidString: id))
    }

    func testReportEncodesTheServerFieldNames() throws {
        let report = InstallReporter.makeReport(defaults: defaults)
        XCTAssertEqual(report.platform, "ios")
        XCTAssertEqual(report.channel, "debug")
        XCTAssertFalse(report.deviceModel.isEmpty)

        let json = try JSONSerialization.jsonObject(
            with: APIClient.encoder.encode(report)) as? [String: Any]
        XCTAssertEqual(
            Set(json?.keys.map { $0 } ?? []),
            ["install_id", "platform", "channel", "app_version", "build", "os_version", "device_model"])
    }
}
