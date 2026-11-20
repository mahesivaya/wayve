package com.hadalspace.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.hadalspace.app.AppState
import com.hadalspace.app.api.ApiError
import com.hadalspace.app.crypto.HadalCrypto
import com.hadalspace.app.crypto.RecoveryPhrase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Unlocks the end-to-end key on this phone with the 24-word recovery phrase,
 * as the web does on a new browser: the phrase unlocks the recovery copy at
 * `GET /api/me/wrapped-key`. The phrase is never stored. Mirrors iOS `UnlockKeyView`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UnlockKeyScreen(appState: AppState, onDone: (unlocked: Boolean) -> Unit) {
    var phrase by remember { mutableStateOf("") }
    var isWorking by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val wordCount = RecoveryPhrase.words(phrase).size

    fun unlock() {
        isWorking = true
        errorMessage = null
        scope.launch {
            try {
                val entropy = RecoveryPhrase.entropy(phrase)
                val envelope = try {
                    appState.api.get<HadalCrypto.RecoveryEnvelope>("/api/me/wrapped-key")
                } catch (e: ApiError.Server) {
                    if (e.status == 404) {
                        errorMessage = "Your account has no recovery copy of its key on Hadal, so it can only be unlocked in the browser that holds it."
                        return@launch
                    }
                    throw e
                }
                // 600k PBKDF2 rounds: keep it off the main thread.
                val pkcs8 = withContext(Dispatchers.Default) { HadalCrypto.unwrapRecovery(envelope, entropy) }
                appState.keyVault.save(pkcs8)
                phrase = ""
                onDone(true)
            } catch (e: Exception) {
                errorMessage = e.message ?: "Couldn't unlock."
            } finally {
                isWorking = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Unlock encrypted mail") },
                navigationIcon = {
                    IconButton(onClick = { onDone(false) }) { Icon(Icons.Default.Close, contentDescription = "Cancel") }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = phrase,
                onValueChange = { phrase = it },
                label = { Text("24-word recovery phrase") },
                minLines = 4,
                maxLines = 8,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "$wordCount of 24 words. Enter the phrase you saved when you set up Hadal, with spaces between words. It unlocks your encrypted mail on this phone and isn't stored.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            errorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = { unlock() }, enabled = wordCount == 24 && !isWorking, modifier = Modifier.fillMaxWidth()) {
                if (isWorking) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Unlock")
            }
            Text(
                "Organization accounts unlock automatically when you sign in with your password.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
