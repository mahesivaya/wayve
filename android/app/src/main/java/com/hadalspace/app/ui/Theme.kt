package com.hadalspace.app.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val HadalBlue = Color(0xFF2563EB)

private val LightColors = lightColorScheme(primary = HadalBlue)
private val DarkColors = darkColorScheme(primary = Color(0xFF60A5FA), background = Color(0xFF0B0F1A), surface = Color(0xFF0B0F1A))

/** Follows the phone's light/dark setting; uses Material You colors on Android 12+. */
@Composable
fun HadalTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        dark -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colors, content = content)
}
