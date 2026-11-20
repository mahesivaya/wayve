package com.hadalspace.app.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.serializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The `/api` client. Mirrors `ios/Fluxze/API/APIClient.swift`: the JWT goes in
 * `Authorization: Bearer`, no cookies are kept (so sign-out is complete), and a
 * 401 on a request that carried a token signs out via [onUnauthorized].
 */
class ApiClient(
    baseUrl: String,
    @Volatile var token: String? = null,
    private val http: OkHttpClient = defaultHttpClient(),
) {
    private val base = baseUrl.trimEnd('/')

    /** Called when a request that carried a token gets a 401. */
    @Volatile var onUnauthorized: (() -> Unit)? = null

    suspend inline fun <reified T> get(path: String): T = decode(serializer<T>(), perform("GET", path, null))

    suspend inline fun <reified T, reified B> post(path: String, body: B): T =
        decode(serializer<T>(), perform("POST", path, encode(serializer<B>(), body)))

    suspend inline fun <reified T, reified B> put(path: String, body: B): T =
        decode(serializer<T>(), perform("PUT", path, encode(serializer<B>(), body)))

    /** A POST whose response body the caller doesn't need; any 2xx is success. */
    suspend inline fun <reified B> postIgnoringResult(path: String, body: B) {
        perform("POST", path, encode(serializer<B>(), body))
    }

    suspend fun delete(path: String) {
        perform("DELETE", path, null)
    }

    fun <B> encode(serializer: KSerializer<B>, body: B): String = ApiJson.encodeToString(serializer, body)

    fun <T> decode(serializer: KSerializer<T>, body: String): T = try {
        ApiJson.decodeFromString(serializer, body)
    } catch (e: SerializationException) {
        throw ApiError.Decoding(e.message ?: e.toString())
    } catch (e: IllegalArgumentException) {
        throw ApiError.Decoding(e.message ?: e.toString())
    }

    /** Sends the request and returns the body of a 2xx; anything else throws. */
    suspend fun perform(method: String, path: String, jsonBody: String?): String =
        withContext(Dispatchers.IO) {
            val url = base + (if (path.startsWith("/")) path else "/$path")
            val sentToken = token
            val builder = Request.Builder()
                .url(url)
                .header("Accept", "application/json")
            if (sentToken != null) builder.header("Authorization", "Bearer $sentToken")
            val requestBody = jsonBody?.toRequestBody(JSON)
            builder.method(method, requestBody ?: if (method == "POST" || method == "PUT") "".toRequestBody(JSON) else null)

            val response = try {
                http.newCall(builder.build()).execute()
            } catch (e: IOException) {
                // The user sees a plain message; the cause goes to logcat for debugging.
                android.util.Log.w("HadalApi", "$method $path failed: $e")
                throw ApiError.Network("Can't reach Hadal. Check your connection and try again.")
            } catch (e: IllegalArgumentException) {
                throw ApiError.Network("Invalid address: $path")
            }

            response.use {
                val text = it.body?.string().orEmpty()
                if (!it.isSuccessful) {
                    val error = ApiError.from(it.code, text)
                    if (error is ApiError.Unauthorized && sentToken != null) onUnauthorized?.invoke()
                    throw error
                }
                text
            }
        }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
