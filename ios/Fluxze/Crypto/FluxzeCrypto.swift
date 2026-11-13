import CommonCrypto
import CryptoKit
import Foundation
import Security

/// The same end-to-end encryption the web app does with WebCrypto, so the phone
/// can open what the browser (and the server, on the user's behalf) sealed:
///   - RSA-OAEP (SHA-256) wraps a per-message AES-256-GCM key.
///   - AES-GCM ciphertext carries its 16-byte tag at the end, as WebCrypto and
///     Rust's aes-gcm both write it.
///   - The private key travels as PKCS#8, locked under a PBKDF2-SHA256 key
///     (600k rounds) derived from the password or the 24-word recovery phrase.
/// Formats are fixed by `frontend/src/crypto/*`, `frontend/src/orgKeys/*` and
/// `backend/crates/wayve-security/src/encryption.rs`; change them together.
enum FluxzeCrypto {
    enum Failure: LocalizedError {
        case badBase64
        case derivationFailed(Int32)
        case wrongSecret
        case badPrivateKey
        case decryptFailed
        case unsupportedEnvelope
        case noSlotForUser

        var errorDescription: String? {
            switch self {
            case .badBase64: "The key data is damaged."
            case .derivationFailed: "Couldn't derive the key."
            case .wrongSecret: "That password or recovery phrase doesn't unlock your key."
            case .badPrivateKey: "Your encryption key couldn't be read."
            case .decryptFailed: "This message couldn't be decrypted with your key."
            case .unsupportedEnvelope: "This message uses an encryption format the app doesn't know."
            case .noSlotForUser: "This message wasn't encrypted for you."
            }
        }
    }

    // MARK: Primitives

    static func pbkdf2SHA256(secret: Data, salt: Data, iterations: Int, length: Int = 32) throws -> Data {
        var derived = [UInt8](repeating: 0, count: length)
        let status: Int32 = secret.withUnsafeBytes { secretBytes in
            salt.withUnsafeBytes { saltBytes in
                derived.withUnsafeMutableBufferPointer { out in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        secretBytes.bindMemory(to: CChar.self).baseAddress, secretBytes.count,
                        saltBytes.bindMemory(to: UInt8.self).baseAddress, saltBytes.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        UInt32(iterations),
                        out.baseAddress, out.count
                    )
                }
            }
        }
        guard status == kCCSuccess else { throw Failure.derivationFailed(status) }
        return Data(derived)
    }

    /// AES-256-GCM open of WebCrypto-style output (ciphertext ‖ 16-byte tag).
    static func aesGCMOpen(key: Data, iv: Data, ciphertextAndTag: Data) throws -> Data {
        guard ciphertextAndTag.count >= 16 else { throw Failure.decryptFailed }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: iv),
            ciphertext: ciphertextAndTag.dropLast(16),
            tag: ciphertextAndTag.suffix(16)
        )
        return try AES.GCM.open(box, using: SymmetricKey(data: key))
    }

    /// An RSA private key from PKCS#8 DER (what WebCrypto exports). iOS takes
    /// the inner PKCS#1 key, so the PKCS#8 wrapper is peeled off first.
    static func privateKey(pkcs8: Data) throws -> SecKey {
        let pkcs1 = try DER.pkcs1FromPKCS8(pkcs8)
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(pkcs1 as CFData, attributes as CFDictionary, &error) else {
            throw Failure.badPrivateKey
        }
        return key
    }

    static func rsaOAEPDecrypt(_ data: Data, with key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let plain = SecKeyCreateDecryptedData(
            key, .rsaEncryptionOAEPSHA256, data as CFData, &error
        ) else {
            throw Failure.decryptFailed
        }
        return plain as Data
    }

    // MARK: Unlocking the private key

    /// The org-member login wrap returned by `POST /api/login`
    /// (`member_login_wrapped_keys`): PBKDF2 over the raw password.
    struct LoginWrap: Codable, Equatable {
        let iv: String
        let ct: String
        let salt: String
        let iterations: Int
    }

    static func unwrapLoginWrap(_ wrap: LoginWrap, password: String) throws -> Data {
        guard let iv = Data(base64Encoded: wrap.iv),
              let ct = Data(base64Encoded: wrap.ct),
              let salt = Data(base64Encoded: wrap.salt) else { throw Failure.badBase64 }
        let key = try pbkdf2SHA256(secret: Data(password.utf8), salt: salt, iterations: wrap.iterations)
        do {
            return try aesGCMOpen(key: key, iv: iv, ciphertextAndTag: ct)
        } catch {
            throw Failure.wrongSecret
        }
    }

    /// The recovery copy at `GET /api/me/wrapped-key`, locked under the 24-word
    /// phrase (`frontend/src/crypto/recovery.ts`).
    struct RecoveryEnvelope: Codable, Equatable {
        let v: Int
        let iv: String
        let pub: String
        let ct: String
    }

    static let recoveryIterations = 600_000
    static let recoverySalt = Data("wayve-recovery-v1".utf8)

    static func unwrapRecovery(_ envelope: RecoveryEnvelope, entropy: Data) throws -> Data {
        guard envelope.v == 1 else { throw Failure.unsupportedEnvelope }
        guard let iv = Data(base64Encoded: envelope.iv),
              let ct = Data(base64Encoded: envelope.ct) else { throw Failure.badBase64 }
        let key = try pbkdf2SHA256(secret: entropy, salt: recoverySalt, iterations: recoveryIterations)
        do {
            return try aesGCMOpen(key: key, iv: iv, ciphertextAndTag: ct)
        } catch {
            throw Failure.wrongSecret
        }
    }

    // MARK: Opening sealed content

    static let securePrefix = "WAYVE_SECURE_V1"

    /// Opens a `WAYVE_SECURE_V1` envelope: an email body sealed on arrival
    /// (`wayve_encrypted`), a Fluxze-to-Fluxze email (`wayve_encrypted_multi`),
    /// or a note (`wayve_self_v1`). Returns nil for text that isn't sealed.
    static func openSecure(_ text: String, userID: Int?, key: SecKey) throws -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(securePrefix) else { return nil }
        guard let start = trimmed.firstIndex(of: "{"),
              let end = trimmed.lastIndex(of: "}"), start < end,
              let json = try? JSONSerialization.jsonObject(with: Data(trimmed[start...end].utf8)) as? [String: Any]
        else { throw Failure.unsupportedEnvelope }

        let wrappedKey: [Int]
        switch json["type"] as? String {
        case "wayve_encrypted":
            guard let k = json["key"] as? [Int] else { throw Failure.unsupportedEnvelope }
            wrappedKey = k
        case "wayve_encrypted_multi", "wayve_self_v1":
            guard let keys = json["keys"] as? [String: [Int]] else { throw Failure.unsupportedEnvelope }
            guard let userID, let k = keys[String(userID)] else { throw Failure.noSlotForUser }
            wrappedKey = k
        default:
            throw Failure.unsupportedEnvelope
        }
        guard let data = json["data"] as? [Int], let iv = json["iv"] as? [Int] else {
            throw Failure.unsupportedEnvelope
        }
        let aesKey = try rsaOAEPDecrypt(bytes(wrappedKey), with: key)
        let plain = try aesGCMOpen(key: aesKey, iv: bytes(iv), ciphertextAndTag: bytes(data))
        guard let string = String(data: plain, encoding: .utf8) else { throw Failure.decryptFailed }
        return string
    }

    private static func bytes(_ values: [Int]) -> Data {
        Data(values.map { UInt8(truncatingIfNeeded: $0) })
    }
}

/// Just enough DER to unwrap a PKCS#8 RSA private key:
///   PrivateKeyInfo ::= SEQUENCE { version INTEGER, algorithm SEQUENCE, privateKey OCTET STRING }
enum DER {
    static func pkcs1FromPKCS8(_ der: Data) throws -> Data {
        var reader = Reader(bytes: [UInt8](der))
        var info = try reader.element(tag: 0x30)  // PrivateKeyInfo
        _ = try info.element(tag: 0x02)           // version
        _ = try info.element(tag: 0x30)           // AlgorithmIdentifier
        let octets = try info.element(tag: 0x04)  // privateKey (PKCS#1)
        return Data(octets.bytes)
    }

    struct Reader {
        var bytes: [UInt8]
        var offset = 0

        /// The next element's contents, which must carry `tag`.
        mutating func element(tag: UInt8) throws -> Reader {
            guard offset < bytes.count, bytes[offset] == tag else { throw FluxzeCrypto.Failure.badPrivateKey }
            offset += 1
            guard offset < bytes.count else { throw FluxzeCrypto.Failure.badPrivateKey }
            var length = Int(bytes[offset])
            offset += 1
            if length & 0x80 != 0 {
                let count = length & 0x7f
                guard count > 0, count <= 4, offset + count <= bytes.count else {
                    throw FluxzeCrypto.Failure.badPrivateKey
                }
                length = bytes[offset..<offset + count].reduce(0) { $0 << 8 | Int($1) }
                offset += count
            }
            guard offset + length <= bytes.count else { throw FluxzeCrypto.Failure.badPrivateKey }
            defer { offset += length }
            return Reader(bytes: Array(bytes[offset..<offset + length]))
        }
    }
}

/// The 24-word recovery phrase (BIP-39, 256-bit entropy + 8-bit checksum),
/// decoded exactly as `frontend/src/crypto/mnemonic.ts` does.
enum RecoveryPhrase {
    enum Failure: LocalizedError, Equatable {
        case wordCount(Int)
        case unknownWord(String)
        case checksum

        var errorDescription: String? {
            switch self {
            case .wordCount(let n): "Your recovery phrase has 24 words; this has \(n)."
            case .unknownWord(let w): "“\(w)” isn't a recovery phrase word. Check the spelling."
            case .checksum: "These words don't form a valid recovery phrase. Check each word and its order."
            }
        }
    }

    private static let index: [String: Int] = Dictionary(
        uniqueKeysWithValues: BIP39.words.enumerated().map { ($1, $0) }
    )

    static func words(in input: String) -> [String] {
        input.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// The 32 bytes of entropy behind a phrase; throws on a wrong word count,
    /// an unknown word, or a bad checksum.
    static func entropy(from input: String) throws -> Data {
        let words = words(in: input)
        guard words.count == 24 else { throw Failure.wordCount(words.count) }
        var bits: [Bool] = []
        bits.reserveCapacity(264)
        for word in words {
            guard let i = index[word] else { throw Failure.unknownWord(word) }
            for shift in stride(from: 10, through: 0, by: -1) {
                bits.append((i >> shift) & 1 == 1)
            }
        }
        var entropy = Data(count: 32)
        for byte in 0..<32 {
            var value: UInt8 = 0
            for bit in 0..<8 where bits[byte * 8 + bit] {
                value |= 1 << (7 - bit)
            }
            entropy[byte] = value
        }
        let checksum = Array(SHA256.hash(data: entropy))[0]
        for bit in 0..<8 where bits[256 + bit] != ((checksum >> (7 - bit)) & 1 == 1) {
            throw Failure.checksum
        }
        return entropy
    }
}
