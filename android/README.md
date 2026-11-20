# Hadal for Android

Native Android app (Kotlin + Jetpack Compose), the counterpart of [`ios/`](../ios).
It calls the same `/api` as the web and iPhone apps; no backend changes are needed.

**Status:** Phase 1 (foundation) + Tasks.

| Area | What's there | iOS source it mirrors |
|---|---|---|
| Sign in | prelogin → `auth_key` (PBKDF2, 600k) or legacy password, email-code verification | `Auth/AuthService.swift`, `Views/LoginView.swift` |
| Session | JWT as `Authorization: Bearer`, sealed by the Android Keystore; 401 signs out | `Auth/Keychain.swift`, `API/APIClient.swift` |
| End-to-end key | unlock at sign-in (org login wrap) or with the 24-word recovery phrase; kept on this device only | `Crypto/*`, `Views/UnlockKeyView.swift` |
| Tasks | list, search, status/priority filters, active/completed, pull to refresh, create/edit/delete, quick complete, move to status | `Tasks/TasksStore.swift`, `Views/TaskListView.swift`, `Views/TaskEditView.swift` |
| Settings | account, encrypted-mail key, links, version, sign out, delete account | `Views/SettingsView.swift` |

Not yet: Inbox, Chat, Calendar, Drive, Code Reviews, notifications.

## Layout

```
app/src/main/java/com/hadalspace/app/
  Config.kt, AppState.kt, MainActivity.kt
  api/      ApiClient (OkHttp), ApiError, ApiJson (snake_case), ServerDate, Models
  auth/     AuthKey, AuthService, SecureStore (Keystore-sealed prefs) + TokenStore
  crypto/   HadalCrypto (PBKDF2, AES-GCM, RSA-OAEP), RecoveryPhrase, Bip39Words, KeyVault
  tasks/    TasksStore (plain class, JVM-tested), Board
  ui/       Theme, RootScreen, LoginScreen, VerifyEmailScreen, tasks/, settings/
app/src/test/   JVM unit tests (crypto vectors, API client, TasksStore)
```

## Build and run

Needs Android Studio (it bundles JDK 17, the SDK and the emulator).

1. Android Studio → **Open** → this `android/` folder. Let it sync; it downloads
   Gradle 8.11.1 from `gradle/wrapper/gradle-wrapper.properties` and creates the
   wrapper scripts. (Without Android Studio: `gradle wrapper` in this folder.)
2. **Device Manager** → create a Pixel 8, Android 15 (arm64-v8a) emulator.
3. Run the `app` configuration, or `./gradlew installDebug`.

Unit tests (no emulator needed): `./gradlew test`.

### Emulator troubleshooting

- **"Can't reach Hadal"** with `UnknownHostException` in logcat (tag `HadalApi`): the
  emulator can't use the Mac's DNS (common when it's IPv6-only, a VPN, or Private
  Relay). Start it with public DNS: `emulator -avd <name> -dns-server 8.8.8.8,1.1.1.1`.
- **Typing on the Mac keyboard does nothing:** set `hw.keyboard=yes` in
  `~/.android/avd/<name>.avd/config.ini` and cold-boot the emulator.

### Pointing a debug build at the local stack

Debug builds use production unless told otherwise. For the dev stack on this Mac,
from the emulator:

```
./gradlew installDebug -Phadal.debugBaseUrl=http://10.0.2.2
```

`10.0.2.2` is the emulator's name for the Mac's `localhost`. Plain HTTP is allowed
only for that address and only in debug builds
(`app/src/debug/res/xml/network_security_config.xml`). Release builds always use
`https://hadalspace.com`.

## Compatibility notes

- **Crypto must match the web and iOS byte for byte.** The tests open the same
  WebCrypto vectors as `ios/FluxzeTests`. `app/src/test/resources/crypto-vectors.json`
  is written by `ios/FluxzeTests/Fixtures/make-crypto-vectors.mjs` together with the
  Swift copy; regenerate both with that script, never edit by hand.
- RSA-OAEP is SHA-256 **with MGF1-SHA-256** (WebCrypto's default). Java's
  `OAEPWithSHA-256AndMGF1Padding` silently uses MGF1-SHA-1, so `HadalCrypto` passes
  an explicit `OAEPParameterSpec`. Don't "simplify" it.
- PBKDF2 is implemented in `HadalCrypto.pbkdf2Sha256` because the recovery secret is
  raw bytes, which `PBEKeySpec` (chars only) can't carry.
- `Bip39Words.kt` is generated from `frontend/src/crypto/wordlist.ts`.

## Release notes

- Application ID `com.hadalspace.app` is permanent once published on Google Play.
- `versionName` follows the iOS `MARKETING_VERSION`; bump `versionCode` for every upload.
- Backups are disabled (`allowBackup=false`, `data_extraction_rules.xml`): the token
  and key are tied to this device's Keystore.
- The launcher icon is a placeholder vector; replace it with the brand artwork
  (Android Studio → New → Image Asset).
- Signing: create an upload key in Android Studio (Build → Generate Signed Bundle)
  and keep it out of git (`*.jks` / `*.keystore` are ignored).
