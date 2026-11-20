package com.hadalspace.app.crypto

import com.hadalspace.app.auth.AuthKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * Opens what the web app and server seal: the same vectors the iOS tests use
 * (made with WebCrypto by ios/FluxzeTests/Fixtures/make-crypto-vectors.mjs),
 * so Android, iOS and the browser stay byte-compatible.
 */
class HadalCryptoTest {
    @Serializable
    private data class Vectors(
        val pkcs8: String,
        val spki: String,
        val password: String,
        val loginWrap: HadalCrypto.LoginWrap,
        val phrase: String,
        val entropy: String,
        val recovery: HadalCrypto.RecoveryEnvelope,
        val userId: Int,
        val single: String,
        val multi: String,
        val note: String,
        val file: String,
        val fileText: String,
    )

    private val v: Vectors = run {
        val text = javaClass.classLoader!!.getResource("crypto-vectors.json")!!.readText()
        Json { ignoreUnknownKeys = true }.decodeFromString(Vectors.serializer(), text)
    }

    private val pkcs8: ByteArray get() = Base64.getDecoder().decode(v.pkcs8)
    private fun b64(s: String) = Base64.getDecoder().decode(s)

    @Test
    fun loginWrapUnlocksWithThePasswordOnly() {
        assertArrayEquals(pkcs8, HadalCrypto.unwrapLoginWrap(v.loginWrap, v.password))
        assertThrows(HadalCrypto.Failure.WrongSecret::class.java) {
            HadalCrypto.unwrapLoginWrap(v.loginWrap, v.password + "x")
        }
    }

    @Test
    fun recoveryPhraseDecodesAndUnlocks() {
        val entropy = RecoveryPhrase.entropy("  " + v.phrase.uppercase() + "\n")
        assertArrayEquals(b64(v.entropy), entropy)
        assertArrayEquals(pkcs8, HadalCrypto.unwrapRecovery(v.recovery, entropy))
    }

    @Test
    fun recoveryPhraseRejectsBadInput() {
        val words = RecoveryPhrase.words(v.phrase).toMutableList()
        val short = assertThrows(RecoveryPhrase.Failure.WordCount::class.java) {
            RecoveryPhrase.entropy(words.dropLast(1).joinToString(" "))
        }
        assertEquals(23, short.count)

        val unknown = assertThrows(RecoveryPhrase.Failure.UnknownWord::class.java) {
            RecoveryPhrase.entropy((words.dropLast(1) + "hadal").joinToString(" "))
        }
        assertEquals("hadal", unknown.word)

        // Swapping two different words almost always breaks the checksum.
        val i = words.indices.first { words[it] != words[0] }
        words[0] = words[i].also { words[i] = words[0] }
        assertThrows(RecoveryPhrase.Failure::class.java) { RecoveryPhrase.entropy(words.joinToString(" ")) }
    }

    @Test
    fun opensEverySealedEnvelopeShape() {
        val key = HadalCrypto.privateKey(pkcs8)
        assertEquals("<p>Hello from the server ✓</p>", HadalCrypto.openSecure(v.single, null, key))
        assertEquals("Fluxze to Fluxze", HadalCrypto.openSecure(v.multi, v.userId, key))
        assertEquals("A private note", HadalCrypto.openSecure(v.note, v.userId, key))
        assertNull(HadalCrypto.openSecure("plain text", v.userId, key))
        assertThrows(HadalCrypto.Failure.NoSlotForUser::class.java) {
            HadalCrypto.openSecure(v.multi, v.userId + 1, key)
        }
    }

    @Test
    fun opensADriveFileEnvelope() {
        val key = HadalCrypto.privateKey(pkcs8)
        val envelope = b64(v.file)
        assertTrue(HadalCrypto.isFileEnvelope(envelope))
        assertArrayEquals(v.fileText.toByteArray(Charsets.UTF_8), HadalCrypto.openFileEnvelope(envelope, key))
        assertFalse(HadalCrypto.isFileEnvelope("%PDF-1.4 plain".toByteArray()))

        val tampered = envelope.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0xFF).toByte() }
        assertThrows(HadalCrypto.Failure.DecryptFailed::class.java) { HadalCrypto.openFileEnvelope(tampered, key) }
    }

    @Test
    fun sealsAndOpensWithThePublishedPublicKey() {
        // The published SPKI key (users.public_key) is the same pair, with
        // WebCrypto's OAEP parameters (SHA-256 and MGF1-SHA-256).
        val public = HadalCrypto.publicKey(b64(v.spki))
        val secret = ByteArray(32) { it.toByte() }
        val wrapped = HadalCrypto.rsaOaepEncrypt(secret, public)
        assertArrayEquals(secret, HadalCrypto.rsaOaepDecrypt(wrapped, HadalCrypto.privateKey(pkcs8)))
    }

    @Test
    fun aesGcmRoundTripsInWebCryptoLayout() {
        val key = ByteArray(32) { 7 }
        val iv = ByteArray(12) { 1 }
        val sealed = HadalCrypto.aesGcmSeal(key, iv, "hi".toByteArray())
        assertEquals(2 + 16, sealed.size) // ciphertext ‖ 16-byte tag
        assertArrayEquals("hi".toByteArray(), HadalCrypto.aesGcmOpen(key, iv, sealed))
    }

    @Test
    fun pbkdf2MatchesTheRfc7914Vector() {
        // RFC 7914 §11: PBKDF2-HMAC-SHA256("passwd", "salt", 1, 64).
        val out = HadalCrypto.pbkdf2Sha256("passwd".toByteArray(), "salt".toByteArray(), 1, 64)
        assertEquals(
            "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc" +
                "49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
            out.joinToString("") { "%02x".format(it) },
        )
    }

    // Vectors computed with the web app's algorithm (WebCrypto PBKDF2, as in
    // frontend/src/auth/authKey.ts) — the same ones ios/FluxzeTests/AuthKeyTests.swift
    // checks. If these drift, the app can't sign in.
    private val authSalt = "AAECAwQFBgcICQoLDA0ODw==" // bytes 0…15

    @Test
    fun authKeyMatchesWebAtFullIterations() {
        assertEquals(
            "X17/d/XSukeZfR3K0rgjuBYqXFtsqPGzfZaNy2xZ+IU=",
            AuthKey.derive("correct horse ⚡ battery", authSalt),
        )
    }

    @Test
    fun authKeyMatchesWebAtLowIterations() {
        assertEquals("uAAYbgVafYlewB5dTgNIlHbl/TtZWJLwTnT+Z9eGOd8=", AuthKey.derive("p@ss", authSalt, 1000))
    }

    @Test
    fun authKeyRejectsBadSalt() {
        assertThrows(AuthKey.BadSalt::class.java) { AuthKey.derive("x", "not base64!", 1) }
    }
}
