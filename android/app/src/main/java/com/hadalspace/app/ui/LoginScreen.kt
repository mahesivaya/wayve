package com.hadalspace.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.hadalspace.app.AppState
import com.hadalspace.app.Config
import com.hadalspace.app.auth.AuthService
import com.hadalspace.app.auth.LoginOutcome
import kotlinx.coroutines.launch

/** Mirrors `ios/Fluxze/Views/LoginView.swift`. */
@Composable
fun LoginScreen(appState: AppState) {
    var identifier by rememberSaveable { mutableStateOf("") }
    // The password is never saved across process death.
    var password by remember { mutableStateOf("") }
    var isWorking by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var verifyMessage by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    val auth = remember(appState) { AuthService(appState.api) }

    val canSubmit = identifier.isNotBlank() && password.isNotEmpty() && !isWorking

    fun signIn() {
        if (isWorking) return
        isWorking = true
        errorMessage = null
        scope.launch {
            try {
                when (val outcome = auth.login(identifier, password)) {
                    is LoginOutcome.SignedIn -> appState.signIn(outcome, password)
                    is LoginOutcome.EmailUnverified -> verifyMessage = outcome.message
                }
            } catch (e: Exception) {
                errorMessage = e.message ?: "Sign-in failed."
            } finally {
                isWorking = false
            }
        }
    }

    val pendingVerify = verifyMessage
    if (pendingVerify != null) {
        BackHandler { verifyMessage = null }
        VerifyEmailScreen(
            api = appState.api,
            email = identifier,
            message = pendingVerify,
            onBack = { verifyMessage = null },
            onVerified = {
                verifyMessage = null
                signIn()
            },
        )
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Hadal", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        Text("Sign in", style = MaterialTheme.typography.titleMedium)

        appState.notice?.let {
            Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        OutlinedTextField(
            value = identifier,
            onValueChange = { identifier = it },
            label = { Text("Email or username") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (canSubmit) signIn() }),
            modifier = Modifier.fillMaxWidth(),
        )

        errorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        Button(onClick = { signIn() }, enabled = canSubmit, modifier = Modifier.fillMaxWidth()) {
            if (isWorking) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                Text("Sign in", fontWeight = FontWeight.Bold)
            }
        }

        TextButton(onClick = { uriHandler.openUri(Config.webUrl("/forgot-password")) }) {
            Text("Forgot password?")
        }
        TextButton(onClick = { uriHandler.openUri(Config.webUrl("/register")) }) {
            Text("New to Hadal? Create an account")
        }
    }
}
