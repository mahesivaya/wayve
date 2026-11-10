import CommonCrypto
import Foundation

/// The login credential sent instead of the password, matching the web app's
/// `frontend/src/auth/authKey.ts` exactly:
///   auth_key = base64(PBKDF2-SHA256("wayve-auth-v1:" + password, auth_salt, 600k, 32 bytes))
enum AuthKey {
    static let iterations = 600_000
    static let context = "wayve-auth-v1:"

    enum Failure: Error {
        case badSalt
        case derivationFailed(Int32)
    }

    static func derive(password: String, saltBase64: String, iterations: Int = iterations) throws -> String {
        guard let salt = Data(base64Encoded: saltBase64) else { throw Failure.badSalt }
        let secret = Array((context + password).utf8).map { CChar(bitPattern: $0) }
        var derived = [UInt8](repeating: 0, count: 32)

        let status: Int32 = salt.withUnsafeBytes { saltBytes in
            secret.withUnsafeBufferPointer { secretBytes in
                derived.withUnsafeMutableBufferPointer { out in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        secretBytes.baseAddress, secretBytes.count,
                        saltBytes.bindMemory(to: UInt8.self).baseAddress, saltBytes.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        UInt32(iterations),
                        out.baseAddress, out.count
                    )
                }
            }
        }
        guard status == kCCSuccess else { throw Failure.derivationFailed(status) }
        return Data(derived).base64EncodedString()
    }
}
