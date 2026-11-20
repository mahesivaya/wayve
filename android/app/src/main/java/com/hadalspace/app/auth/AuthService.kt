package com.hadalspace.app.auth

import com.hadalspace.app.api.ApiClient
import com.hadalspace.app.api.ApiError
import com.hadalspace.app.crypto.HadalCrypto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

sealed interface LoginOutcome {
    data class SignedIn(val token: String, val loginWrap: HadalCrypto.LoginWrap?) : LoginOutcome

    /** The account exists but its email isn't verified yet (403 `email_unverified`). */
    data class EmailUnverified(val message: String) : LoginOutcome
}

/**
 * Password sign-in, mirroring the web's two-step flow and
 * `ios/Fluxze/Auth/AuthService.swift`: `POST /api/auth/prelogin` says which
 * scheme the account uses, then `POST /api/login` gets a derived `auth_key`
 * (scheme 2) or, for a legacy scheme-1 account, the password.
 */
class AuthService(private val api: ApiClient) {
    @Serializable private data class PreloginBody(val email: String)
    @Serializable private data class PreloginResponse(val scheme: Int, val authSalt: String? = null)
    @Serializable private data class LoginBody(val email: String, val password: String? = null, val authKey: String? = null)
    @Serializable private data class LoginResponse(val token: String, val loginWrap: HadalCrypto.LoginWrap? = null)
    @Serializable private data class EmailBody(val email: String)
    @Serializable private data class VerifyBody(val email: String, val code: String)

    suspend fun login(identifier: String, password: String): LoginOutcome {
        val email = identifier.trim()
        val prelogin: PreloginResponse = api.post("/api/auth/prelogin", PreloginBody(email))

        val salt = prelogin.authSalt
        val body = if (prelogin.scheme == 2 && salt != null) {
            // 600k PBKDF2 rounds: keep it off the main thread.
            val authKey = withContext(Dispatchers.Default) { AuthKey.derive(password, salt) }
            LoginBody(email = email, authKey = authKey)
        } else {
            LoginBody(email = email, password = password)
        }

        return try {
            val response: LoginResponse = api.post("/api/login", body)
            LoginOutcome.SignedIn(response.token, response.loginWrap)
        } catch (e: ApiError.Server) {
            if (e.code == "email_unverified") LoginOutcome.EmailUnverified(e.message) else throw e
        }
    }

    suspend fun verifyEmail(email: String, code: String) {
        api.postIgnoringResult("/api/verify-email", VerifyBody(email.trim(), code.trim()))
    }

    suspend fun resendVerification(email: String) {
        api.postIgnoringResult("/api/resend-verification", EmailBody(email.trim()))
    }

    companion object {
        /**
         * Unlocks the end-to-end key with the password just typed, as the web
         * does at login. Best-effort: a failure leaves the key locked (the
         * recovery phrase can still unlock it) and never blocks signing in.
         */
        suspend fun unlockKey(wrap: HadalCrypto.LoginWrap, password: String): ByteArray? =
            withContext(Dispatchers.Default) {
                runCatching { HadalCrypto.unwrapLoginWrap(wrap, password) }.getOrNull()
            }
    }
}
