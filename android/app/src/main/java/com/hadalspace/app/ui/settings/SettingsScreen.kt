package com.hadalspace.app.ui.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import com.hadalspace.app.AppState
import com.hadalspace.app.BuildConfig
import com.hadalspace.app.Config
import kotlinx.coroutines.launch

/** Mirrors `ios/Fluxze/Views/SettingsView.swift` (the parts the Android app has so far). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(appState: AppState, onClose: () -> Unit) {
    val uriHandler = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    var hasKey by remember { mutableStateOf(appState.keyVault.hasKey) }
    var unlocking by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var isDeleting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    if (unlocking) {
        BackHandler { unlocking = false }
        UnlockKeyScreen(appState, onDone = { unlocked ->
            unlocking = false
            if (unlocked) hasKey = true
        })
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, contentDescription = "Close") }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            SectionTitle("Account")
            val me = appState.me
            val username = me?.username?.takeIf { it.isNotBlank() && it != me.email }
            val usernameLine: (@Composable () -> Unit)? = username?.let { name -> @Composable { Text(name) } }
            ListItem(
                headlineContent = { Text(me?.email ?: "Signed in") },
                supportingContent = usernameLine,
                leadingContent = { Icon(Icons.Default.Person, contentDescription = null) },
            )

            SectionTitle("Encrypted mail")
            ListItem(
                headlineContent = { Text(if (hasKey) "Unlocked on this phone" else "Locked on this phone") },
                supportingContent = {
                    Text("With your key on this phone, encrypted content opens here like it does in your browser. The key stays on this device and is removed when you sign out.")
                },
                leadingContent = { Icon(if (hasKey) Icons.Default.LockOpen else Icons.Default.Lock, contentDescription = null) },
            )
            if (hasKey) {
                TextButton(
                    onClick = { appState.keyVault.delete(); hasKey = false },
                    modifier = Modifier.padding(horizontal = 8.dp),
                ) { Text("Remove key from this phone", color = MaterialTheme.colorScheme.error) }
            } else {
                TextButton(onClick = { unlocking = true }, modifier = Modifier.padding(horizontal = 8.dp)) {
                    Text("Unlock with recovery phrase")
                }
            }

            SectionTitle("About")
            LinkItem("Hadal on the web") { uriHandler.openUri(Config.webUrl("/")) }
            LinkItem("Privacy policy") { uriHandler.openUri(Config.webUrl("/privacy")) }
            ListItem(
                headlineContent = { Text("Version") },
                trailingContent = { Text("${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})") },
                leadingContent = { Icon(Icons.Default.Info, contentDescription = null) },
            )

            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
            TextButton(onClick = { appState.signOut() }, modifier = Modifier.fillMaxWidth()) { Text("Sign out") }
            TextButton(
                onClick = { confirmDelete = true },
                enabled = !isDeleting,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (isDeleting) "Deleting…" else "Delete account", color = MaterialTheme.colorScheme.error) }
            Text(
                "Permanently deletes your Hadal account and its data. Organization accounts are managed by their organization.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
            errorMessage?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete your account?") },
            text = { Text("This permanently deletes your account, tasks and other data. It can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    isDeleting = true
                    errorMessage = null
                    scope.launch {
                        try {
                            appState.deleteAccount()
                        } catch (e: Exception) {
                            errorMessage = e.message
                        } finally {
                            isDeleting = false
                        }
                    }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp),
    )
}

@Composable
private fun LinkItem(title: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title) },
        trailingContent = { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = "Opens in browser") },
        modifier = Modifier.clickable(onClick = onClick),
    )
}
