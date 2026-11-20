package com.hadalspace.app.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset

/**
 * The server's timestamps: RFC 3339 with a zone, or a zone-less `NaiveDateTime`
 * (taken as UTC), with an optional fraction and a `T` or a space. Mirrors
 * `ios/Fluxze/API/ServerDate.swift`.
 */
object ServerDate {
    private val pattern = Regex(
        """^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$"""
    )

    fun parse(text: String): Instant? {
        val m = pattern.matchEntire(text.trim()) ?: return null
        val g = m.groupValues
        val nanos = g[7].takeIf { it.isNotEmpty() }
            ?.let { (it + "000000000").take(9).toInt() } ?: 0
        val local = runCatching {
            LocalDateTime.of(g[1].toInt(), g[2].toInt(), g[3].toInt(), g[4].toInt(), g[5].toInt(), g[6].toInt(), nanos)
        }.getOrNull() ?: return null

        val zone = g[8]
        val offset = if (zone.isEmpty() || zone == "Z") {
            ZoneOffset.UTC
        } else {
            val sign = if (zone.startsWith("-")) -1 else 1
            val digits = zone.drop(1).replace(":", "")
            val hours = digits.take(2).toIntOrNull() ?: 0
            val minutes = digits.takeLast(2).toIntOrNull() ?: 0
            runCatching { ZoneOffset.ofHoursMinutes(sign * hours, sign * minutes) }.getOrNull() ?: return null
        }
        return local.toInstant(offset)
    }
}

/** (De)serializes an [Instant] in the server's format; writes ISO-8601 UTC. */
object ServerInstantSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("ServerInstant", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Instant {
        val text = decoder.decodeString()
        return ServerDate.parse(text)
            ?: throw kotlinx.serialization.SerializationException("Unrecognized date: $text")
    }

    override fun serialize(encoder: Encoder, value: Instant) {
        encoder.encodeString(value.toString())
    }
}
