package com.hadalspace.app.crypto

import android.content.Context
import com.hadalspace.app.auth.SecureStore
import java.security.PrivateKey

/**
 * Holds the user's end-to-end private key (PKCS#8) on this device only, sealed
 * by the Keystore, and erased on sign-out. The password or phrase that
 * unlocked it is never stored. Mirrors `ios/Fluxze/Crypto/KeyVault.swift`.
 */
class KeyVault(context: Context) {
    private val store = SecureStore(context, "com.hadalspace.app.e2e", "e2e")

    @Volatile private var cached: PrivateKey? = null

    /** Validates before storing, so a bad unwrap never replaces a good key. */
    fun save(pkcs8: ByteArray) {
        val key = HadalCrypto.privateKey(pkcs8)
        store.put(NAME, pkcs8)
        cached = key
    }

    fun privateKey(): PrivateKey? {
        cached?.let { return it }
        val pkcs8 = store.get(NAME) ?: return null
        return runCatching { HadalCrypto.privateKey(pkcs8) }.getOrNull()?.also { cached = it }
    }

    val hasKey: Boolean get() = privateKey() != null

    fun delete() {
        store.remove(NAME)
        cached = null
    }

    private companion object {
        const val NAME = "private-key"
    }
}
