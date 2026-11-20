package com.hadalspace.app

/** Where the app talks to. Mirrors `ios/Fluxze/Config.swift`. */
object Config {
    const val PRODUCTION_URL = "https://hadalspace.com"

    /** Production in release builds; a debug build reads `hadal.debugBaseUrl`. */
    val baseUrl: String = BuildConfig.BASE_URL.trimEnd('/')

    fun webUrl(path: String): String = baseUrl + (if (path.startsWith("/")) path else "/$path")
}
