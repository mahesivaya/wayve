import XCTest
@testable import Fluxze

/// Opens what the web app and server seal (vectors made with WebCrypto by
/// Fixtures/make-crypto-vectors.mjs), so the phone stays compatible.
final class FluxzeCryptoTests: XCTestCase {
    private struct Vectors: Decodable {
        let pkcs8: String
        let spki: String
        let password: String
        let loginWrap: FluxzeCrypto.LoginWrap
        let phrase: String
        let entropy: String
        let recovery: FluxzeCrypto.RecoveryEnvelope
        let userId: Int
        let single: String
        let multi: String
        let note: String
        let file: String
        let fileText: String
        let chat: String
        let chatText: String
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

    func testOpensADriveFileEnvelope() throws {
        let key = try FluxzeCrypto.privateKey(pkcs8: pkcs8)
        let envelope = Data(base64Encoded: v.file)!
        XCTAssertTrue(FluxzeCrypto.isFileEnvelope(envelope))
        XCTAssertEqual(try FluxzeCrypto.openFileEnvelope(envelope, key: key), Data(v.fileText.utf8))
        XCTAssertFalse(FluxzeCrypto.isFileEnvelope(Data("%PDF-1.4 plain".utf8)))
        var tampered = envelope
        tampered[tampered.count - 1] ^= 0xFF
        XCTAssertThrowsError(try FluxzeCrypto.openFileEnvelope(tampered, key: key))
    }

    func testOpensAChatMessageSealedOnTheWeb() throws {
        let key = try FluxzeCrypto.privateKey(pkcs8: pkcs8)
        XCTAssertTrue(ChatCrypto.isEnvelope(v.chat))
        XCTAssertEqual(ChatCrypto.open(v.chat, userID: v.userId, key: key), .text(v.chatText))
        // Not for this user, no key on the phone, plain text, and damage.
        XCTAssertEqual(ChatCrypto.open(v.chat, userID: v.userId + 1, key: key), .notForYou)
        XCTAssertEqual(ChatCrypto.open(v.chat, userID: v.userId, key: nil), .locked)
        XCTAssertEqual(ChatCrypto.open("Hello", userID: v.userId, key: nil), .text("Hello"))
        XCTAssertEqual(ChatCrypto.open(ChatCrypto.prefix + "{nope", userID: v.userId, key: key), .unreadable)
    }

    func testSealsAChatMessageInTheWebShape() throws {
        let privateKey = try FluxzeCrypto.privateKey(pkcs8: pkcs8)
        // The published SPKI key (as users.public_key holds it) is the same pair.
        let publicKey = try ChatCrypto.publicKey(spki: [UInt8](Data(base64Encoded: v.spki)!))
        let sealed = try ChatCrypto.seal("From the iPhone ✓", for: [v.userId: publicKey, 7: publicKey])

        XCTAssertTrue(sealed.hasPrefix("WAYVE_CHAT_E2E_V1\n"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(sealed.dropFirst(ChatCrypto.prefix.count).utf8)) as? [String: Any])
        XCTAssertEqual(json["type"] as? String, "wayve_chat_e2e")
        XCTAssertEqual((json["iv"] as? [Int])?.count, 12)
        XCTAssertEqual(Set((json["keys"] as? [String: Any] ?? [:]).keys), ["\(v.userId)", "7"])

        XCTAssertEqual(ChatCrypto.open(sealed, userID: v.userId, key: privateKey), .text("From the iPhone ✓"))
        XCTAssertEqual(ChatCrypto.open(sealed, userID: 7, key: privateKey), .text("From the iPhone ✓"))
        XCTAssertThrowsError(try ChatCrypto.seal("x", for: [:]))
    }

    @MainActor
    func testEmailsStoreOpensWithTheKeyAndNotWithout() throws {
        let key = try FluxzeCrypto.privateKey(pkcs8: pkcs8)
        XCTAssertEqual(EmailsStore.open(v.single, userID: v.userId, key: key), "<p>Hello from the server ✓</p>")
        XCTAssertNil(EmailsStore.open(v.single, userID: v.userId, key: nil))
    }
}
