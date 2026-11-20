package com.hadalspace.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.hadalspace.app.AppState
import com.hadalspace.app.ui.settings.SettingsScreen
import com.hadalspace.app.ui.tasks.TasksScreen

/** Signed out → sign in; signed in → Tasks, with Settings on top. */
@Composable
fun RootScreen(appState: AppState) {
    Surface(modifier = Modifier.fillMaxSize()) {
        when (val phase = appState.phase) {
            AppState.Phase.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            AppState.Phase.SignedOut -> LoginScreen(appState)
            is AppState.Phase.SignedIn -> SignedInScreen(appState)
        }
    }
}

@Composable
private fun SignedInScreen(appState: AppState) {
    var showingSettings by rememberSaveable { mutableStateOf(false) }

    if (showingSettings) {
        BackHandler { showingSettings = false }
        SettingsScreen(appState, onClose = { showingSettings = false })
    } else {
        // Keyed to the session, so a different sign-in never sees the last one's tasks.
        TasksScreen(
            api = appState.api,
            sessionKey = appState.api.token.orEmpty(),
            onOpenSettings = { showingSettings = true },
        )
    }
}
