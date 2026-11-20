package com.hadalspace.app.crypto

import java.security.MessageDigest

/**
 * The 24-word recovery phrase (BIP-39, 256-bit entropy + 8-bit checksum),
 * decoded exactly as `frontend/src/crypto/mnemonic.ts` does. Mirrors
 * `RecoveryPhrase` in `ios/Fluxze/Crypto/FluxzeCrypto.swift`.
 */
object RecoveryPhrase {
    sealed class Failure(message: String) : Exception(message) {
        data class WordCount(val count: Int) :
            Failure("Your recovery phrase has 24 words; this has $count.")

        data class UnknownWord(val word: String) :
            Failure("“$word” isn't a recovery phrase word. Check the spelling.")

        object Checksum :
            Failure("These words don't form a valid recovery phrase. Check each word and its order.")
    }

    private val index: Map<String, Int> by lazy {
        Bip39Words.words.withIndex().associate { (i, w) -> w to i }
    }

    fun words(input: String): List<String> =
        input.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

    /** The 32 bytes of entropy behind a phrase; throws on a wrong count, unknown word, or bad checksum. */
    fun entropy(input: String): ByteArray {
        val words = words(input)
        if (words.size != 24) throw Failure.WordCount(words.size)
        val bits = BooleanArray(264)
        var pos = 0
        for (word in words) {
            val i = index[word] ?: throw Failure.UnknownWord(word)
            for (shift in 10 downTo 0) bits[pos++] = (i shr shift) and 1 == 1
        }
        val entropy = ByteArray(32)
        for (byte in 0 until 32) {
            var value = 0
            for (bit in 0 until 8) if (bits[byte * 8 + bit]) value = value or (1 shl (7 - bit))
            entropy[byte] = value.toByte()
        }
        val checksum = MessageDigest.getInstance("SHA-256").digest(entropy)[0].toInt() and 0xFF
        for (bit in 0 until 8) {
            if (bits[256 + bit] != ((checksum shr (7 - bit)) and 1 == 1)) throw Failure.Checksum
        }
        return entropy
    }
}
