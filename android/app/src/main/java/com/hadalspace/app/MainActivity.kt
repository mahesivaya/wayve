package com.hadalspace.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.hadalspace.app.ui.HadalTheme
import com.hadalspace.app.ui.RootScreen

class MainActivity : ComponentActivity() {
    private val appState: AppState by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            HadalTheme {
                RootScreen(appState)
            }
        }
    }
}
