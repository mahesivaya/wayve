package com.hadalspace.app.auth

import com.hadalspace.app.crypto.HadalCrypto
import java.util.Base64

/**
 * The login credential sent instead of the password, matching the web app's
 * `frontend/src/auth/authKey.ts` exactly:
 *   auth_key = base64(PBKDF2-SHA256("wayve-auth-v1:" + password, auth_salt, 600k, 32 bytes))
 */
object AuthKey {
    const val ITERATIONS = 600_000
    private const val CONTEXT = "wayve-auth-v1:"

    class BadSalt : Exception("The server sent an unreadable sign-in salt.")

    fun derive(password: String, saltBase64: String, iterations: Int = ITERATIONS): String {
        val salt = try {
            Base64.getDecoder().decode(saltBase64)
        } catch (e: IllegalArgumentException) {
            throw BadSalt()
        }
        val derived = HadalCrypto.pbkdf2Sha256((CONTEXT + password).toByteArray(Charsets.UTF_8), salt, iterations)
        return Base64.getEncoder().encodeToString(derived)
    }
}
