package com.hadalspace.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.hadalspace.app.api.ApiClient
import com.hadalspace.app.auth.AuthService
import kotlinx.coroutines.launch

/** The 6-digit email code, then sign in. Mirrors iOS `VerifyEmailView`. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VerifyEmailScreen(
    api: ApiClient,
    email: String,
    message: String,
    onBack: () -> Unit,
    onVerified: () -> Unit,
) {
    var code by remember { mutableStateOf("") }
    var isWorking by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val auth = remember(api) { AuthService(api) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Verify your email") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
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
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(message)
            Text("Enter the 6-digit code we emailed to $email.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.filter(Char::isDigit).take(6) },
                label = { Text("Verification code") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )
            errorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            info?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }

            Button(
                onClick = {
                    isWorking = true
                    errorMessage = null
                    scope.launch {
                        try {
                            auth.verifyEmail(email, code)
                            onVerified()
                        } catch (e: Exception) {
                            errorMessage = e.message
                        } finally {
                            isWorking = false
                        }
                    }
                },
                enabled = code.length == 6 && !isWorking,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Verify and sign in") }

            TextButton(
                onClick = {
                    isWorking = true
                    errorMessage = null
                    scope.launch {
                        try {
                            auth.resendVerification(email)
                            info = "If that address needs verifying, a new code is on its way."
                        } catch (e: Exception) {
                            errorMessage = e.message
                        } finally {
                            isWorking = false
                        }
                    }
                },
                enabled = !isWorking,
            ) { Text("Send a new code") }
        }
    }
}
