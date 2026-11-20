package com.hadalspace.app.api

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy

/**
 * JSON as the server speaks it: snake_case keys, unknown keys ignored (the
 * server adds fields freely), and absent optionals left out rather than sent
 * as `null` (iOS's `encodeIfPresent`).
 */
@OptIn(ExperimentalSerializationApi::class)
val ApiJson: Json = Json {
    namingStrategy = JsonNamingStrategy.SnakeCase
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}
