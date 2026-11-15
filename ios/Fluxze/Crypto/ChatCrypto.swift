import CryptoKit
import Foundation
import Security

/// Chat's end-to-end envelope, byte for byte the web's (`frontend/src/chat/e2ee.ts`):
///
///     WAYVE_CHAT_E2E_V1\n{"type":"wayve_chat_e2e","data":[…],"iv":[…],"keys":{"<user id>":[…]}}
///
/// One fresh AES-256-GCM key per message encrypts the text (`data` is
/// ciphertext ‖ tag); that key is RSA-OAEP-SHA256 wrapped once per recipient,
/// the sender included, so every participant can read it on any device.
enum ChatCrypto {
    static let prefix = "WAYVE_CHAT_E2E_V1\n"

    private struct Envelope: Codable {
        let type: String
        let data: [UInt8]
        let iv: [UInt8]
        let keys: [String: [UInt8]]
    }

    /// What a message shows when it can't be opened, worded as on the web.
    enum Opened: Equatable {
        case text(String)
        /// Encrypted, and the key isn't on this iPhone.
        case locked
        /// Encrypted for others, before this user had a key.
        case notForYou
        case unreadable
    }

    static func isEnvelope(_ content: String) -> Bool {
        content.hasPrefix(prefix)
    }

    /// Plain text (a standard-encryption message) comes back as is.
    static func open(_ content: String, userID: Int?, key: SecKey?) -> Opened {
        guard isEnvelope(content) else { return .text(content) }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(content.dropFirst(prefix.count).utf8)),
              envelope.type == "wayve_chat_e2e" else { return .unreadable }
        guard let key else { return .locked }
        guard let userID, let wrapped = envelope.keys[String(userID)] else { return .notForYou }
        do {
            let aesKey = try FluxzeCrypto.rsaOAEPDecrypt(Data(wrapped), with: key)
            let plain = try FluxzeCrypto.aesGCMOpen(key: aesKey, iv: Data(envelope.iv), ciphertextAndTag: Data(envelope.data))
            guard let text = String(data: plain, encoding: .utf8) else { return .unreadable }
            return .text(text)
        } catch {
            return .unreadable
        }
    }

    /// Seals `text` for each recipient's public key, by user id.
    static func seal(_ text: String, for recipients: [Int: SecKey]) throws -> String {
        guard !recipients.isEmpty else { throw FluxzeCrypto.Failure.noSlotForUser }
        let aesKey = SymmetricKey(size: .bits256)
        let nonce = AES.GCM.Nonce()
        let box = try AES.GCM.seal(Data(text.utf8), using: aesKey, nonce: nonce)
        let rawKey = aesKey.withUnsafeBytes { Data($0) }

        var keys: [String: [UInt8]] = [:]
        for (userID, publicKey) in recipients {
            var error: Unmanaged<CFError>?
            guard let wrapped = SecKeyCreateEncryptedData(
                publicKey, .rsaEncryptionOAEPSHA256, rawKey as CFData, &error
            ) else { throw FluxzeCrypto.Failure.badPrivateKey }
            keys[String(userID)] = [UInt8](wrapped as Data)
        }
        let envelope = Envelope(
            type: "wayve_chat_e2e",
            data: [UInt8](box.ciphertext + box.tag),
            iv: [UInt8](Data(nonce)),
            keys: keys
        )
        let json = try JSONEncoder().encode(envelope)
        return prefix + String(decoding: json, as: UTF8.self)
    }

    /// A public key from SPKI DER bytes, as `users.public_key` holds them.
    static func publicKey(spki: [UInt8]) throws -> SecKey {
        let pkcs1 = try DER.pkcs1FromSPKI(Data(spki))
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(pkcs1 as CFData, attributes as CFDictionary, &error) else {
            throw FluxzeCrypto.Failure.badPrivateKey
        }
        return key
    }
}

extension DER {
    /// The RSAPublicKey inside SubjectPublicKeyInfo (what WebCrypto exports):
    ///   SEQUENCE { algorithm SEQUENCE, subjectPublicKey BIT STRING }
    static func pkcs1FromSPKI(_ der: Data) throws -> Data {
        var reader = Reader(bytes: [UInt8](der))
        var info = try reader.element(tag: 0x30)
        _ = try info.element(tag: 0x30)
        let bits = try info.element(tag: 0x03)
        // The first byte counts unused bits; a key always has none.
        guard let unused = bits.bytes.first, unused == 0 else { throw FluxzeCrypto.Failure.badPrivateKey }
        return Data(bits.bytes.dropFirst())
    }
}
