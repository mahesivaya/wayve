import Foundation
import Security

/// Holds the user's end-to-end private key (PKCS#8) in the Keychain: readable
/// only while the phone is unlocked, never synced to iCloud or restored to
/// another phone, and erased on sign-out. The phrase or password that unlocked
/// it is never stored.
enum KeyVault {
    private static let service = "com.fluxze.app.e2e"
    private static let account = "private-key"

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// Decoded once per launch; SecKey creation isn't free.
    nonisolated(unsafe) private static var cached: SecKey?

    static func save(pkcs8: Data) throws {
        // Validate before storing, so a bad unwrap never replaces a good key.
        let key = try FluxzeCrypto.privateKey(pkcs8: pkcs8)
        SecItemDelete(baseQuery as CFDictionary)
        var query = baseQuery
        query[kSecValueData as String] = pkcs8
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw FluxzeCrypto.Failure.badPrivateKey }
        cached = key
    }

    static func privateKey() -> SecKey? {
        if let cached { return cached }
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let key = try? FluxzeCrypto.privateKey(pkcs8: data) else { return nil }
        cached = key
        return key
    }

    static var hasKey: Bool { privateKey() != nil }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
        cached = nil
    }
}
