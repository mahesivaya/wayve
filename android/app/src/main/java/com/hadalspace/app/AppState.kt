package com.hadalspace.app

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.hadalspace.app.api.ApiClient
import com.hadalspace.app.api.ApiError
import com.hadalspace.app.api.Me
import com.hadalspace.app.auth.AuthService
import com.hadalspace.app.auth.LoginOutcome
import com.hadalspace.app.auth.TokenStore
import com.hadalspace.app.crypto.KeyVault
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Mirrors `ios/Fluxze/AppState.swift`. Survives rotation as a ViewModel. */
class AppState(application: Application) : AndroidViewModel(application) {
    sealed interface Phase {
        data object Loading : Phase
        data object SignedOut : Phase
        /** [me] is null when the token is kept but `/api/me` couldn't be reached. */
        data class SignedIn(val me: Me?) : Phase
    }

    private val tokens = TokenStore(application)
    val keyVault = KeyVault(application)
    val api = ApiClient(Config.baseUrl, token = tokens.load())

    var phase: Phase by mutableStateOf(Phase.Loading)
        private set

    /** A one-off message for the sign-in screen, such as "session expired". */
    var notice: String? by mutableStateOf(null)

    val me: Me? get() = (phase as? Phase.SignedIn)?.me

    init {
        api.onUnauthorized = {
            viewModelScope.launch(Dispatchers.Main) {
                signOut("Your session has expired. Please sign in again.")
            }
        }
        viewModelScope.launch { restore() }
    }

    /** On launch: keep the saved session if the server still accepts it. */
    private suspend fun restore() {
        if (api.token == null) {
            phase = Phase.SignedOut
            return
        }
        loadMe()
    }

    /** Signs in with the outcome of [AuthService.login], unlocking the key if the server sent a wrap. */
    suspend fun signIn(outcome: LoginOutcome.SignedIn, password: String) {
        withContext(Dispatchers.IO) { tokens.save(outcome.token) }
        api.token = outcome.token
        notice = null
        outcome.loginWrap?.let { wrap ->
            AuthService.unlockKey(wrap, password)?.let { pkcs8 -> runCatching { keyVault.save(pkcs8) } }
        }
        loadMe()
    }

    fun signOut(notice: String? = null) {
        tokens.delete()
        // The end-to-end key leaves with the session.
        keyVault.delete()
        api.token = null
        this.notice = notice
        phase = Phase.SignedOut
    }

    /** `DELETE /api/me`. Only personal accounts can; the server's reason is thrown otherwise. */
    suspend fun deleteAccount() {
        api.delete("/api/me")
        signOut("Your account has been deleted.")
    }

    private suspend fun loadMe() {
        phase = try {
            Phase.SignedIn(api.get<Me>("/api/me"))
        } catch (e: ApiError.Unauthorized) {
            // onUnauthorized signs out as well; make sure we land signed out.
            tokens.delete()
            api.token = null
            Phase.SignedOut
        } catch (e: ApiError) {
            Phase.SignedIn(null)
        }
    }
}
