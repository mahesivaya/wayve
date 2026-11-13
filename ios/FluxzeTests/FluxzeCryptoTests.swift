import XCTest
@testable import Fluxze

/// Opens what the web app and server seal (vectors made with WebCrypto by
/// Fixtures/make-crypto-vectors.mjs), so the phone stays compatible.
final class FluxzeCryptoTests: XCTestCase {
    private struct Vectors: Decodable {
        let pkcs8: String
        let password: String
        let loginWrap: FluxzeCrypto.LoginWrap
        let phrase: String
        let entropy: String
        let recovery: FluxzeCrypto.RecoveryEnvelope
        let userId: Int
        let single: String
        let multi: String
        let note: String
    }

    private let v: Vectors = {
        do {
            return try JSONDecoder().decode(Vectors.self, from: Data(CryptoVectors.json.utf8))
        } catch {
            fatalError("CryptoVectors.json: \(error)")
        }
    }()

    private var pkcs8: Data { Data(base64Encoded: v.pkcs8)! }

    func testLoginWrapUnlocksWithThePasswordOnly() throws {
        XCTAssertEqual(try FluxzeCrypto.unwrapLoginWrap(v.loginWrap, password: v.password), pkcs8)
        XCTAssertThrowsError(try FluxzeCrypto.unwrapLoginWrap(v.loginWrap, password: v.password + "x"))
    }

    func testRecoveryPhraseDecodesAndUnlocks() throws {
        let entropy = try RecoveryPhrase.entropy(from: "  " + v.phrase.uppercased() + "\n")
        XCTAssertEqual(entropy, Data(base64Encoded: v.entropy))
        XCTAssertEqual(try FluxzeCrypto.unwrapRecovery(v.recovery, entropy: entropy), pkcs8)
    }

    func testRecoveryPhraseRejectsBadInput() {
        var words = RecoveryPhrase.words(in: v.phrase)
        XCTAssertThrowsError(try RecoveryPhrase.entropy(from: words.dropLast().joined(separator: " "))) {
            XCTAssertEqual($0 as? RecoveryPhrase.Failure, .wordCount(23))
        }
        XCTAssertThrowsError(try RecoveryPhrase.entropy(from: (words.dropLast() + ["fluxze"]).joined(separator: " "))) {
            XCTAssertEqual($0 as? RecoveryPhrase.Failure, .unknownWord("fluxze"))
        }
        // Swapping two different words almost always breaks the checksum.
        if let i = words.indices.first(where: { words[$0] != words[0] }) {
            words.swapAt(0, i)
            XCTAssertThrowsError(try RecoveryPhrase.entropy(from: words.joined(separator: " ")))
        }
    }

    func testOpensEverySealedEnvelopeShape() throws {
        let key = try FluxzeCrypto.privateKey(pkcs8: pkcs8)
        XCTAssertEqual(try FluxzeCrypto.openSecure(v.single, userID: nil, key: key), "<p>Hello from the server ✓</p>")
        XCTAssertEqual(try FluxzeCrypto.openSecure(v.multi, userID: v.userId, key: key), "Fluxze to Fluxze")
        XCTAssertEqual(try FluxzeCrypto.openSecure(v.note, userID: v.userId, key: key), "A private note")
        XCTAssertNil(try FluxzeCrypto.openSecure("plain text", userID: v.userId, key: key))
        XCTAssertThrowsError(try FluxzeCrypto.openSecure(v.multi, userID: v.userId + 1, key: key))
    }

    @MainActor
    func testEmailsStoreOpensWithTheKeyAndNotWithout() throws {
        let key = try FluxzeCrypto.privateKey(pkcs8: pkcs8)
        XCTAssertEqual(EmailsStore.open(v.single, userID: v.userId, key: key), "<p>Hello from the server ✓</p>")
        XCTAssertNil(EmailsStore.open(v.single, userID: v.userId, key: nil))
    }
}
