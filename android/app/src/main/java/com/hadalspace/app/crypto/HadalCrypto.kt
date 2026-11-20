package com.hadalspace.app.crypto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/**
 * The same end-to-end encryption the web app does with WebCrypto, so the phone
 * opens what the browser (and the server, on the user's behalf) sealed.
 * Mirrors `ios/Fluxze/Crypto/FluxzeCrypto.swift`:
 *   - RSA-OAEP (SHA-256, MGF1-SHA-256) wraps a per-message AES-256-GCM key.
 *   - AES-GCM ciphertext carries its 16-byte tag at the end (WebCrypto layout).
 *   - The private key travels as PKCS#8, locked under a PBKDF2-SHA256 key
 *     (600k rounds) derived from the password or the 24-word recovery phrase.
 * Formats are fixed by `frontend/src/crypto/`, `frontend/src/orgKeys/` and
 * `backend/crates/wayve-security/src/encryption.rs`; change them together.
 */
object HadalCrypto {
    sealed class Failure(message: String) : Exception(message) {
        object BadBase64 : Failure("The key data is damaged.")
        object WrongSecret : Failure("That password or recovery phrase doesn't unlock your key.")
        object BadPrivateKey : Failure("Your encryption key couldn't be read.")
        object DecryptFailed : Failure("This message couldn't be decrypted with your key.")
        object UnsupportedEnvelope : Failure("This message uses an encryption format the app doesn't know.")
        object NoSlotForUser : Failure("This message wasn't encrypted for you.")
    }

    // ---- Primitives -------------------------------------------------------

    /**
     * PBKDF2-HMAC-SHA256 over raw bytes. Implemented directly rather than with
     * `SecretKeyFactory("PBKDF2WithHmacSHA256")`, whose `PBEKeySpec` takes a
     * `char[]` and so can't carry the recovery phrase's raw entropy bytes.
     */
    fun pbkdf2Sha256(secret: ByteArray, salt: ByteArray, iterations: Int, length: Int = 32): ByteArray {
        require(iterations > 0 && length > 0)
        val mac = Mac.getInstance("HmacSHA256")
        // HMAC zero-pads the key, so an empty key equals a single zero byte;
        // SecretKeySpec rejects an empty array.
        mac.init(SecretKeySpec(if (secret.isEmpty()) byteArrayOf(0) else secret, "HmacSHA256"))
        val hLen = mac.macLength
        val blocks = (length + hLen - 1) / hLen
        val out = ByteArray(blocks * hLen)
        for (block in 1..blocks) {
            mac.update(salt)
            mac.update(byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
            var u = mac.doFinal()
            val t = u.copyOf()
            repeat(iterations - 1) {
                u = mac.doFinal(u)
                for (i in t.indices) t[i] = (t[i].toInt() xor u[i].toInt()).toByte()
            }
            t.copyInto(out, (block - 1) * hLen)
        }
        return out.copyOf(length)
    }

    /** AES-256-GCM open of WebCrypto-style output (ciphertext ‖ 16-byte tag). */
    fun aesGcmOpen(key: ByteArray, iv: ByteArray, ciphertextAndTag: ByteArray): ByteArray {
        if (ciphertextAndTag.size < 16) throw Failure.DecryptFailed
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.doFinal(ciphertextAndTag)
        } catch (e: Exception) {
            throw Failure.DecryptFailed
        }
    }

    /** AES-256-GCM seal, returning ciphertext ‖ tag (WebCrypto layout). */
    fun aesGcmSeal(key: ByteArray, iv: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return cipher.doFinal(plaintext)
    }

    /** An RSA private key from PKCS#8 DER, as WebCrypto exports it. */
    fun privateKey(pkcs8: ByteArray): PrivateKey = try {
        KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(pkcs8))
    } catch (e: Exception) {
        throw Failure.BadPrivateKey
    }

    /** An RSA public key from SPKI DER (`users.public_key`). */
    fun publicKey(spki: ByteArray): PublicKey = try {
        KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(spki))
    } catch (e: Exception) {
        throw Failure.BadPrivateKey
    }

    /** WebCrypto's RSA-OAEP with SHA-256: MGF1 must be SHA-256 too (Java defaults it to SHA-1). */
    private val oaepSha256 = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)

    fun rsaOaepDecrypt(data: ByteArray, key: PrivateKey): ByteArray = try {
        val cipher = Cipher.getInstance("RSA/ECB/OAEPPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, oaepSha256)
        cipher.doFinal(data)
    } catch (e: Exception) {
        throw Failure.DecryptFailed
    }

    fun rsaOaepEncrypt(data: ByteArray, key: PublicKey): ByteArray {
        val cipher = Cipher.getInstance("RSA/ECB/OAEPPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, oaepSha256)
        return cipher.doFinal(data)
    }

    // ---- Unlocking the private key ---------------------------------------

    /** The org-member login wrap from `POST /api/login`: PBKDF2 over the raw password. */
    @Serializable
    data class LoginWrap(val iv: String, val ct: String, val salt: String, val iterations: Int)

    fun unwrapLoginWrap(wrap: LoginWrap, password: String): ByteArray {
        val iv = b64(wrap.iv)
        val ct = b64(wrap.ct)
        val salt = b64(wrap.salt)
        val key = pbkdf2Sha256(password.toByteArray(Charsets.UTF_8), salt, wrap.iterations)
        return try {
            aesGcmOpen(key, iv, ct)
        } catch (e: Failure) {
            throw Failure.WrongSecret
        }
    }

    /** The recovery copy at `GET /api/me/wrapped-key`, locked under the 24-word phrase. */
    @Serializable
    data class RecoveryEnvelope(val v: Int, val iv: String, val pub: String, val ct: String)

    const val RECOVERY_ITERATIONS = 600_000
    val recoverySalt: ByteArray = "wayve-recovery-v1".toByteArray(Charsets.UTF_8)

    fun unwrapRecovery(envelope: RecoveryEnvelope, entropy: ByteArray): ByteArray {
        if (envelope.v != 1) throw Failure.UnsupportedEnvelope
        val iv = b64(envelope.iv)
        val ct = b64(envelope.ct)
        val key = pbkdf2Sha256(entropy, recoverySalt, RECOVERY_ITERATIONS)
        return try {
            aesGcmOpen(key, iv, ct)
        } catch (e: Failure) {
            throw Failure.WrongSecret
        }
    }

    // ---- Opening sealed content ------------------------------------------

    const val SECURE_PREFIX = "WAYVE_SECURE_V1"

    /**
     * Opens a `WAYVE_SECURE_V1` envelope: an email body sealed on arrival
     * (`wayve_encrypted`), a Hadal-to-Hadal email (`wayve_encrypted_multi`), or
     * a note (`wayve_self_v1`). Returns null for text that isn't sealed.
     */
    fun openSecure(text: String, userId: Int?, key: PrivateKey): String? {
        val trimmed = text.trim()
        if (!trimmed.startsWith(SECURE_PREFIX)) return null
        val json = jsonBody(trimmed) ?: throw Failure.UnsupportedEnvelope

        val wrappedKey: ByteArray = when ((json["type"] as? JsonPrimitive)?.content) {
            "wayve_encrypted" -> bytes(json["key"]) ?: throw Failure.UnsupportedEnvelope
            "wayve_encrypted_multi", "wayve_self_v1" -> {
                val keys = json["keys"] as? JsonObject ?: throw Failure.UnsupportedEnvelope
                if (userId == null) throw Failure.NoSlotForUser
                bytes(keys[userId.toString()]) ?: throw Failure.NoSlotForUser
            }
            else -> throw Failure.UnsupportedEnvelope
        }
        val data = bytes(json["data"]) ?: throw Failure.UnsupportedEnvelope
        val iv = bytes(json["iv"]) ?: throw Failure.UnsupportedEnvelope
        val aesKey = rsaOaepDecrypt(wrappedKey, key)
        val plain = aesGcmOpen(aesKey, iv, data)
        return String(plain, Charsets.UTF_8)
    }

    /**
     * The binary envelope Drive files are stored in (`fileEnvelope.ts`), big-endian:
     *   "WV1\0" | version u16 = 1 | iv (12) | wlen u32 | wrapped key | AES-GCM data + tag
     */
    private val fileMagic = byteArrayOf(0x57, 0x56, 0x31, 0x00)

    fun isFileEnvelope(data: ByteArray): Boolean =
        data.size >= 6 && data.copyOfRange(0, 4).contentEquals(fileMagic)

    fun openFileEnvelope(data: ByteArray, key: PrivateKey): ByteArray {
        if (!isFileEnvelope(data) || data.size < 22) throw Failure.UnsupportedEnvelope
        val version = (u8(data[4]) shl 8) or u8(data[5])
        if (version != 1) throw Failure.UnsupportedEnvelope
        val iv = data.copyOfRange(6, 18)
        val wrappedLength = (18 until 22).fold(0L) { acc, i -> (acc shl 8) or u8(data[i]).toLong() }
        // RSA-2048 wraps to 256 bytes, RSA-4096 to 512; the web caps it at 1 KB.
        if (wrappedLength <= 0 || wrappedLength > 1024 || 22 + wrappedLength > data.size) {
            throw Failure.UnsupportedEnvelope
        }
        val end = 22 + wrappedLength.toInt()
        val wrapped = data.copyOfRange(22, end)
        val ciphertext = data.copyOfRange(end, data.size)
        val aesKey = rsaOaepDecrypt(wrapped, key)
        return aesGcmOpen(aesKey, iv, ciphertext)
    }

    // ---- Helpers ----------------------------------------------------------

    private val lenientJson = Json { ignoreUnknownKeys = true }

    /** The JSON object between the first `{` and the last `}`. */
    internal fun jsonBody(text: String): JsonObject? {
        val start = text.indexOf('{')
        val end = text.lastIndexOf('}')
        if (start < 0 || end <= start) return null
        return runCatching { lenientJson.parseToJsonElement(text.substring(start, end + 1)) as? JsonObject }
            .getOrNull()
    }

    /** A JSON array of byte values (0–255) as WebCrypto envelopes write them. */
    internal fun bytes(element: Any?): ByteArray? {
        val array = element as? JsonArray ?: return null
        val out = ByteArray(array.size)
        for ((i, item) in array.withIndex()) {
            val value = (item as? JsonPrimitive)?.intOrNull ?: return null
            out[i] = value.toByte()
        }
        return out
    }

    internal fun b64(text: String): ByteArray = try {
        Base64.getDecoder().decode(text)
    } catch (e: IllegalArgumentException) {
        throw Failure.BadBase64
    }

    private fun u8(b: Byte): Int = b.toInt() and 0xFF
}
