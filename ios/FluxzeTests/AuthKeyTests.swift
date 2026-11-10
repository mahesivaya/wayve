import XCTest
@testable import Fluxze

/// Vectors computed with the web app's algorithm (WebCrypto PBKDF2, as in
/// frontend/src/auth/authKey.ts). If these drift, the app can't sign in.
final class AuthKeyTests: XCTestCase {
    private let salt = "AAECAwQFBgcICQoLDA0ODw=="  // bytes 0…15

    func testMatchesWebAtFullIterations() throws {
        XCTAssertEqual(
            try AuthKey.derive(password: "correct horse ⚡ battery", saltBase64: salt),
            "X17/d/XSukeZfR3K0rgjuBYqXFtsqPGzfZaNy2xZ+IU=")
    }

    func testMatchesWebAtLowIterations() throws {
        XCTAssertEqual(
            try AuthKey.derive(password: "p@ss", saltBase64: salt, iterations: 1000),
            "uAAYbgVafYlewB5dTgNIlHbl/TtZWJLwTnT+Z9eGOd8=")
    }

    func testRejectsBadSalt() {
        XCTAssertThrowsError(try AuthKey.derive(password: "x", saltBase64: "not base64!", iterations: 1))
    }
}
