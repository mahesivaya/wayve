package com.hadalspace.app.api

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/** A failed request. Mirrors `ios/Fluxze/API/APIError.swift`. */
sealed class ApiError(override val message: String) : Exception(message) {
    /** 401: the session is missing, expired, or the credentials are wrong. */
    class Unauthorized(message: String) : ApiError(message)

    /** Any other non-2xx. [code] is the body's `error` field (e.g. `email_unverified`). */
    class Server(val status: Int, val code: String?, message: String) : ApiError(message)

    class Network(message: String) : ApiError(message)

    class Decoding(val detail: String) :
        ApiError("The server sent a response the app couldn't read.")

    val errorCode: String? get() = (this as? Server)?.code

    companion object {
        private const val SESSION_EXPIRED = "Your session has expired. Please sign in again."

        /** The backend answers with `{"message"}`, `{"error","message"}`, plain text, or nothing. */
        fun from(status: Int, body: String): ApiError {
            var message: String? = null
            var code: String? = null
            val obj = runCatching { ApiJson.parseToJsonElement(body) as? JsonObject }.getOrNull()
            if (obj != null) {
                message = (obj["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                code = (obj["error"] as? JsonPrimitive)?.takeIf { it.isString }?.jsonPrimitive?.content
            } else {
                val text = body.trim()
                if (text.isNotEmpty() && text.length < 300) message = text
            }
            if (message.isNullOrEmpty()) message = null

            return when {
                status == 401 -> {
                    val text = message ?: SESSION_EXPIRED
                    Unauthorized(if (text == "unauthorized") SESSION_EXPIRED else text)
                }
                status == 429 -> Server(
                    status, code, message ?: "Too many attempts. Please wait a minute and try again."
                )
                status >= 500 -> Server(status, code, "Something went wrong on the server. Please try again.")
                else -> Server(status, code, message ?: "Request failed ($status).")
            }
        }
    }
}
