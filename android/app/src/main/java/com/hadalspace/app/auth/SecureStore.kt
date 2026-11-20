package com.hadalspace.app.auth

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small values (the session token, the end-to-end private key) sealed with an
 * AES-256-GCM key that lives in the Android Keystore and can't be exported.
 * Only the ciphertext reaches SharedPreferences, and backups are disabled in
 * the manifest, so nothing is restorable on another device. Plays the role of
 * the iOS Keychain (`ios/Fluxze/Auth/Keychain.swift`, `Crypto/KeyVault.swift`).
 */
class SecureStore(context: Context, private val keyAlias: String, prefsName: String) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    fun put(name: String, value: ByteArray) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(value)
        prefs.edit().putString(name, Base64.getEncoder().encodeToString(sealed)).apply()
    }

    fun get(name: String): ByteArray? {
        val stored = prefs.getString(name, null) ?: return null
        return runCatching {
            val sealed = Base64.getDecoder().decode(stored)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_LENGTH))
            cipher.doFinal(sealed, IV_LENGTH, sealed.size - IV_LENGTH)
        }.getOrElse {
            // Unreadable (e.g. the Keystore key was reset): treat as absent.
            remove(name)
            null
        }
    }

    fun putString(name: String, value: String) = put(name, value.toByteArray(Charsets.UTF_8))

    fun getString(name: String): String? = get(name)?.toString(Charsets.UTF_8)

    fun remove(name: String) {
        prefs.edit().remove(name).apply()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_LENGTH = 12
    }
}

/** The session token (the JWT). */
class TokenStore(context: Context) {
    private val store = SecureStore(context, "com.hadalspace.app.session", "session")

    fun load(): String? = store.getString(NAME)
    fun save(token: String) = store.putString(NAME, token)
    fun delete() = store.remove(NAME)

    private companion object {
        const val NAME = "jwt"
    }
}
