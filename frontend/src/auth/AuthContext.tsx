import { useEffect, useRef, useState } from "react";
import {
  savePrivateKey,
  savePublicKey,
  loadPrivateKey,
  loadPublicKey,
  requestPersistentStorage,
  clearKeys,
} from "../crypto/keyStore";
import { generateMnemonic, mnemonicToEntropy } from "../crypto/mnemonic";
import { wrapKeysForRecovery } from "../crypto/recovery";
import {
  uploadWrappedKey,
  fetchWrappedKey,
  fetchBasicKey,
  deleteBasicKey,
} from "../api/recovery";
import RecoverySeedModal from "../recovery/RecoverySeedModal";
import RecoverPromptModal from "../recovery/RecoverPromptModal";
import { getMe, logout as logoutRequest, saveUserPublicKey } from "../api/Auth";
import { apiFetch } from "../api/client";
import { clearAuthToken, getAuthToken, setAuthToken } from "./token";
import { useIdleLogout } from "./useIdleLogout";
import { logger } from "../utils/logger";
import { isDesktopApp } from "../utils/desktop";
import { normalizeAccountType } from "./accountHome";
import { parseJwt, resolveBootToken } from "./bootToken";
import { defaultAccessForAccount } from "./defaultAccess";
import {
  AuthContext,
  type RecoveryMode,
  type UserType,
} from "./authContextValue";

// Plan A collapsed RecoveryMode to just "full"; the helper still exists
// so older /api/me payloads from a partially-migrated deployment can be
// normalized in one place.
const normalizeRecoveryMode = (_value: unknown): RecoveryMode => "full";

const log = logger.scope("auth");

async function publishPublicKey(publicKey: ArrayBuffer) {
  await saveUserPublicKey(publicKey);
}

// PBKDF2 settings — match the org-member login-wrap (encryption.rs
// ORG_MEMBER_PBKDF2_ITERATIONS). Browser-CSPRNG salt + nonce.
const LOGIN_WRAP_PBKDF2_ITERATIONS = 600_000;

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Wrap the user's freshly-generated PKCS8 private key under
// PBKDF2(password) and PUT to /api/me/login-wrap. Lets the same user
// auto-unlock on any new browser by re-deriving the AES key from their
// typed password — no mnemonic prompt unless they forget the password.
async function uploadPasswordLoginWrap(
  privateKey: CryptoKey,
  password: string
): Promise<void> {
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", privateKey)
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.slice().buffer,
      iterations: LOGIN_WRAP_PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    pkcs8.slice().buffer
  );

  // Zero the plaintext PKCS8 bytes we copied into JS memory. Best-effort
  // — JS can't guarantee a fresh allocation didn't already snapshot it.
  pkcs8.fill(0);

  await apiFetch("/api/me/login-wrap", {
    method: "PUT",
    body: JSON.stringify({
      iv: bytesToB64(iv),
      ct: bytesToB64(new Uint8Array(ciphertext)),
      salt: bytesToB64(salt),
      iterations: LOGIN_WRAP_PBKDF2_ITERATIONS,
    }),
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const authVersion = useRef(0);

  // Captured once at AuthProvider mount. resolveBootToken cleans the URL
  // hash as a side effect, so the `signup`/`sso&new=true` markers are
  // gone by the time the bootstrap useEffect runs. Stashing the parsed
  // result in state lets both the optimistic-user initializer and the
  // effect see the same snapshot.
  const [boot] = useState(resolveBootToken);

  // Optimistic init: trust a non-expired JWT immediately so the app renders
  // without a round-trip. /api/me below confirms it and logs us out on 401.
  const [user, setUser] = useState<UserType | null>(() => {
    if (!boot.token) return null;
    const claims = parseJwt(boot.token);
    const access = claims ? defaultAccessForAccount(claims.account_type) : null;
    return claims
      ? {
          email: claims.email,
          id: claims.sub,
          account_type: normalizeAccountType(claims.account_type),
          effective_role: access?.effective_role,
          role_label: access?.role_label,
          scope: access?.scope ?? null,
          permissions: access?.permissions ?? [],
          organization_id: claims.organization_id ?? null,
          // The JWT carries no org slug/name — /api/me fills these in below.
          organization_slug: null,
          organization_name: null,
        }
      : null;
  });
  const [initializing, setInitializing] = useState(() => !getAuthToken());

  // ============================================================
  // Recovery seed orchestration
  // ============================================================
  // When `pendingMnemonic` is set, the modal is rendered at the bottom of
  // the provider. `pendingWrapJob` is the closure the modal calls after
  // the user has verified the words — wrapping the private key + uploading
  // the envelope happens THEN, so a user who never confirms doesn't end
  // up with a recovery copy they don't know exists.
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);
  const [pendingWrapJob, setPendingWrapJob] = useState<
    (() => Promise<void>) | null
  >(null);
  // Track the user's recovery_mode at modal-open time so the seed-modal
  // copy can adapt (full = "restore on a new device too"; password_only
  // = "this resets a forgotten password only").
  const [pendingRecoveryMode, setPendingRecoveryMode] =
    useState<RecoveryMode>("full");
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapError, setWrapError] = useState<string | null>(null);
  // True when a "full"-mode user logs in on a device without local
  // encryption keys. Blocks the UI behind RecoverPromptModal until they
  // enter their 24-word recovery phrase (the one shown once at register).
  const [needsRecovery, setNeedsRecovery] = useState(false);

  // No `needsRestore` banner here anymore. On a "new device" (no local
  // key, server envelope present) the user can navigate to /recover on
  // their own — auto-nagging caused too many false positives in dev
  // (port switching) and confused real users. Lazy restore wins.

  // Import a PKCS8 RSA-OAEP private key blob and derive the matching
  // SPKI public key. WebCrypto can't extract a public CryptoKey from a
  // private one directly, but exporting → re-importing the JWK form
  // yields a usable encrypt key. Returns the SPKI bytes (what
  // savePublicKey + publishPublicKey expect downstream).
  const importPkcs8AndDerivePublicSpki = async (
    pkcs8: ArrayBuffer
  ): Promise<{ privateKey: CryptoKey; publicKeyBytes: ArrayBuffer }> => {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["decrypt"]
    );
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    const pubJwk: JsonWebKey = {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: "RSA-OAEP-256",
      ext: true,
    };
    const publicCryptoKey = await crypto.subtle.importKey(
      "jwk",
      pubJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"]
    );
    const publicKeyBytes = await crypto.subtle.exportKey(
      "spki",
      publicCryptoKey
    );
    return { privateKey, publicKeyBytes };
  };

  // Plan A encryption bootstrap. Exactly one mode ('full') exists, so
  // there's no branching on `recovery_mode` — only on what state the
  // current device/server is in:
  //
  //   1. Local IndexedDB already has the keypair  → publish the public
  //      key and return; nothing else to do.
  //
  //   2. No local key, but the server has a wrapped envelope on file
  //      → another device set this user up. Show RecoverPromptModal so
  //      the user pastes their 24 words; that flow imports the keys.
  //
  //   3. No local key, no wrapped envelope on file, BUT the server has
  //      a legacy `basic-key` PKCS8 envelope  → this is a pre-Plan-A
  //      'basic' user logging in after the migration. Pull the PKCS8,
  //      import it, generate a brand-new mnemonic, prep a wrap+delete
  //      closure, and show the seed modal. Once the user confirms,
  //      the wrap uploads and the legacy basic-key blob is DELETEd —
  //      the mnemonic becomes the only path back in.
  //
  //   4. None of the above  → fresh signup (or a SQL-seeded account
  //      that never finished setup). Generate a new keypair, generate
  //      a mnemonic, prep a wrap closure, and show the seed modal.
  const setupEncryption = async (
    userId: number,
    _recoveryMode: RecoveryMode,
    email: string,
    isFreshRegistration: boolean,
    // Just-typed password, used once to derive the PBKDF2 login-wrap and
    // upload it. Lives only on this stack frame; not stored.
    plaintextPassword?: string
  ) => {
    try {
      // Ask the browser to keep the keystore from being evicted, so the cached
      // keypair survives a hard refresh and we don't re-prompt for the 24-word
      // mnemonic. Fire-and-forget — must never block encryption setup.
      void requestPersistentStorage();

      // (1) Local key already on this device. A fresh registration
      // still wants brand-new keys, even if IndexedDB has stale
      // entries from a prior dev session — short-circuiting here
      // would skip the seed modal and leave the user with keys that
      // don't match the server's new wrapped envelope.
      if (!isFreshRegistration) {
        const existingKey = await loadPrivateKey(userId, email);
        const existingPublicKey = await loadPublicKey(userId, email);

        if (existingKey && existingPublicKey) {
          await publishPublicKey(existingPublicKey);
          log.debug(
            "encryption key already in IndexedDB; public key refreshed"
          );
          return;
        }
      }

      // (2) Server-side wrapped envelope already exists. We must NOT
      // regenerate or the original mnemonic would be orphaned. Defer
      // to RecoverPromptModal so the user enters their 24 words.
      if (!isFreshRegistration) {
        const serverWrapped = await fetchWrappedKey();
        if (serverWrapped) {
          log.info("encryption keys missing — prompting for recovery mnemonic");
          setNeedsRecovery(true);
          return;
        }
      }

      // (3) Migration: legacy 'basic' user whose RSA private key still
      // lives on the server as `users.private_key_encrypted`. Pull it
      // once, wrap it under a fresh mnemonic, upload the envelope, and
      // schedule the basic-key DELETE so the mnemonic becomes the only
      // recovery path. The user MUST save the 24 words — there is no
      // second chance.
      if (!isFreshRegistration) {
        const legacyPkcs8 = await fetchBasicKey().catch((err) => {
          log.warn("legacy basic-key fetch failed", err);
          return null;
        });
        if (legacyPkcs8) {
          log.info(
            "migration: legacy basic-key found, upgrading to mnemonic-wrap"
          );
          const { privateKey, publicKeyBytes } =
            await importPkcs8AndDerivePublicSpki(legacyPkcs8);
          await savePrivateKey(privateKey, userId, email);
          await savePublicKey(publicKeyBytes, userId, email);
          await publishPublicKey(publicKeyBytes);

          const mnemonic = await generateMnemonic();
          const wrapJob = async () => {
            const entropy = await mnemonicToEntropy(mnemonic);
            const envelope = await wrapKeysForRecovery(
              privateKey,
              publicKeyBytes,
              entropy
            );
            await uploadWrappedKey(envelope);
            // Once the wrap is on file, drop the legacy server-held
            // PKCS8 envelope so the mnemonic is the only path back in.
            // Failure to delete is non-fatal — the wrap is already
            // uploaded; we just log and move on, and a future login
            // can retry the DELETE.
            try {
              await deleteBasicKey();
              log.info("migration: legacy basic-key DELETEd from server");
            } catch (err) {
              log.warn(
                "migration: legacy basic-key DELETE failed (non-fatal)",
                err
              );
            }
          };

          setPendingWrapJob(() => wrapJob);
          setPendingRecoveryMode("full");
          setPendingMnemonic(mnemonic);
          log.info(
            "migration: imported legacy key, mnemonic generated, awaiting user confirmation"
          );
          return;
        }
      }

      // (4) Truly fresh setup — either a brand-new signup or a SQL-
      // seeded account on its first login with no envelope anywhere.
      log.info("generating new RSA key pair");

      const keyPair = await crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"]
      );

      await savePrivateKey(keyPair.privateKey, userId, email);

      const publicKey = await crypto.subtle.exportKey(
        "spki",
        keyPair.publicKey
      );
      await savePublicKey(publicKey, userId, email);

      await publishPublicKey(publicKey);

      // Password-derived login wrap: lets the user sign in from a new
      // browser without being prompted for the 24-word phrase. The wrap
      // is AES-256-GCM(PBKDF2-SHA256-600k(password)) over the PKCS8
      // bytes of the private key, PUT to /api/me/login-wrap. The
      // mnemonic recovery path (below) stays in place as the
      // forgot-password fallback. If `plaintextPassword` is missing
      // (legacy callers, SSO without password), we skip silently and
      // the user keeps the mnemonic-only flow.
      if (plaintextPassword) {
        try {
          await uploadPasswordLoginWrap(keyPair.privateKey, plaintextPassword);
          log.info("password login-wrap uploaded");
        } catch (err) {
          log.warn("password login-wrap upload failed (non-fatal)", err);
        }
      }

      // The mnemonic is generated in the browser; only the user
      // ever sees it. The wrap closure runs AFTER the user confirms
      // they've saved the 24 words — a user who closes the modal
      // never uploads a recovery envelope.
      const mnemonic = await generateMnemonic();
      const wrapJob = async () => {
        const entropy = await mnemonicToEntropy(mnemonic);
        const envelope = await wrapKeysForRecovery(
          keyPair.privateKey,
          publicKey,
          entropy
        );
        await uploadWrappedKey(envelope);
      };

      setPendingWrapJob(() => wrapJob);
      setPendingRecoveryMode("full");
      setPendingMnemonic(mnemonic);

      log.info(
        "encryption setup complete; awaiting recovery-seed confirmation"
      );
    } catch (err) {
      log.error("encryption setup failed", err);
    }
  };

  const handleRecoveryConfirmed = async () => {
    if (!pendingWrapJob) return;
    setWrapBusy(true);
    setWrapError(null);
    try {
      await pendingWrapJob();
      setPendingMnemonic(null);
      setPendingWrapJob(null);
    } catch (err) {
      log.error("recovery key upload failed", err);
      setWrapError(
        err instanceof Error
          ? `Couldn't save recovery copy: ${err.message}`
          : "Couldn't save recovery copy. Try again."
      );
    } finally {
      setWrapBusy(false);
    }
  };

  useEffect(() => {
    const token = getAuthToken();

    // Validate in the background. AbortController makes StrictMode's
    // double-mount in dev clean up the first request instead of racing.
    const ctrl = new AbortController();

    void (async () => {
      try {
        const res = await getMe(token, ctrl.signal);

        if (res.status === 401) {
          if (authVersion.current > 0) {
            return;
          }
          log.warn("/api/me rejected stored token; clearing session");
          clearAuthToken();
          setUser(null);
          // No hard redirect: ProtectedRoute already sends unauthenticated
          // users away from protected pages, and public pages (/login,
          // /register, /reset-password, ...) must stay rendered.
          return;
        }

        if (!res.ok) {
          const txt = await res.text();
          log.error("/api/me failed", { status: res.status, body: txt });
          return;
        }

        const data = await res.json();
        const nextUser: UserType = {
          email: data.email,
          id: data.id,
          username: data.username ?? null,
          account_type: normalizeAccountType(data.account_type),
          effective_role: data.effective_role ?? null,
          role_label: data.role_label ?? null,
          scope: data.scope ?? null,
          permissions: data.permissions ?? [],
          is_primary_owner: data.is_primary_owner ?? false,
          mode: data.mode === "admin" ? "admin" : "normal",
          can_switch_admin: data.can_switch_admin ?? false,
          organization_id: data.organization_id ?? null,
          organization_slug: data.organization_slug ?? null,
          organization_name: data.organization_name ?? null,
          current_plan: data.current_plan ?? null,
          recovery_mode: normalizeRecoveryMode(data.recovery_mode),
          theme_json: data.theme_json ?? null,
          chat_encrypt_files: data.chat_encrypt_files ?? true,
        };
        // Only patch state if the server sees a different user — avoids a
        // pointless re-render when the optimistic claims already matched.
        setUser((prev) =>
          prev &&
          prev.id === nextUser.id &&
          prev.email === nextUser.email &&
          prev.account_type === nextUser.account_type &&
          prev.effective_role === nextUser.effective_role &&
          prev.role_label === nextUser.role_label &&
          prev.scope === nextUser.scope &&
          (prev.permissions ?? []).join(",") ===
            (nextUser.permissions ?? []).join(",") &&
          prev.organization_id === nextUser.organization_id &&
          prev.organization_slug === nextUser.organization_slug &&
          prev.organization_name === nextUser.organization_name &&
          (prev.username ?? null) === (nextUser.username ?? null) &&
          prev.recovery_mode === nextUser.recovery_mode &&
          (prev.theme_json ?? null) === (nextUser.theme_json ?? null) &&
          // Plan changes (upgrade / downgrade / new subscription) need to
          // trigger a re-render so the tier badge + Upgrade affordance
          // refresh. Comparing the `code` is enough — other plan fields
          // only change when `code` does.
          (prev.current_plan?.code ?? null) ===
            (nextUser.current_plan?.code ?? null)
            ? prev
            : nextUser
        );

        // Bootstrap effect normally runs for already-signed-in users on
        // every page load, so isFreshRegistration is false. The exception
        // is a Google/SSO landing where the URL hash carried `signup=true`
        // (or `sso=true&new=true`) — those users skip Register.tsx
        // entirely and would otherwise be asked for a 24-word phrase they
        // were never given.
        setupEncryption(
          nextUser.id,
          nextUser.recovery_mode ?? "full",
          nextUser.email,
          boot.isFreshSignup
        ).catch((err) => log.error("background encryption setup failed", err));
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        log.error("auth init network error", err);
      } finally {
        setInitializing(false);
      }
    })();

    return () => ctrl.abort();
    // `setupEncryption` is intentionally omitted from the dep array: it's
    // defined in the component body (not memoized) and we want this effect
    // to run once on mount only. Adding it would re-run the entire auth
    // bootstrap on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = (
    token: string,
    accountType?: string,
    isFreshRegistration = false,
    // Just-typed plaintext password, forwarded from the login/register form.
    // We use it once inside `setupEncryption` to compute a PBKDF2 wrap of
    // the freshly-generated personal RSA private key, so the user's next
    // login from a new browser can auto-unlock without prompting for the
    // 24-word mnemonic. Never persisted, never logged.
    plaintextPassword?: string
  ) => {
    authVersion.current += 1;
    setAuthToken(token);
    setInitializing(false);

    const decoded = parseJwt(token);

    if (decoded) {
      const normalizedAccountType = normalizeAccountType(
        accountType ?? decoded.account_type
      );
      const access = defaultAccessForAccount(normalizedAccountType);
      setUser({
        email: decoded.email,
        id: decoded.sub,
        username: null, // Will be filled by the post-login /api/me fetch
        account_type: normalizedAccountType,
        effective_role: access.effective_role,
        role_label: access.role_label,
        scope: access.scope,
        permissions: access.permissions,
        organization_id: decoded.organization_id ?? null,
        organization_slug: null,
        organization_name: null,
      });
      // The AuthProvider /api/me effect only runs once at mount, so a fresh
      // login needs its own profile fetch to learn the org slug/name that
      // drive organization routing AND the recovery_mode that decides
      // which envelope shape setupEncryption uploads.
      getMe(token)
        .then(async (res) => {
          if (!res.ok) return;
          const data = await res.json();
          const recoveryMode = normalizeRecoveryMode(data.recovery_mode);
          setUser({
            email: data.email,
            id: data.id,
            username: data.username ?? null,
            account_type: normalizeAccountType(data.account_type),
            effective_role: data.effective_role ?? null,
            role_label: data.role_label ?? null,
            scope: data.scope ?? null,
            permissions: data.permissions ?? [],
            is_primary_owner: data.is_primary_owner ?? false,
            mode: data.mode === "admin" ? "admin" : "normal",
            can_switch_admin: data.can_switch_admin ?? false,
            organization_id: data.organization_id ?? null,
            organization_slug: data.organization_slug ?? null,
            organization_name: data.organization_name ?? null,
            current_plan: data.current_plan ?? null,
            recovery_mode: recoveryMode,
            theme_json: data.theme_json ?? null,
          });
          setupEncryption(
            decoded.sub,
            recoveryMode,
            data.email,
            isFreshRegistration,
            plaintextPassword
          ).catch((err) =>
            log.error("background encryption setup failed", err)
          );
        })
        .catch((err) => log.error("post-login profile fetch failed", err));
    }
  };

  // Soft session-expiry: the API client dispatches `rwayve:session-expired`
  // on a 401 (instead of hard-reloading to /login). Drop the user locally so
  // ProtectedRoute does an in-app redirect — no full-page "blink".
  useEffect(() => {
    const onExpired = () => {
      authVersion.current += 1;
      clearAuthToken();
      setUser(null);
      setNeedsRecovery(false);
    };
    window.addEventListener("rwayve:session-expired", onExpired);
    return () =>
      window.removeEventListener("rwayve:session-expired", onExpired);
  }, []);

  const logout = (reason: "manual" | "idle" = "manual") => {
    authVersion.current += 1;
    clearAuthToken();
    // Explicit logout = "I'm leaving this machine": wipe the cached E2E keys so
    // the private key doesn't linger in IndexedDB on a shared device. NOT done
    // on session-expiry (that keeps the key so re-login stays prompt-free).
    void clearKeys();
    setNeedsRecovery(false);
    // Idle timeout: leave a breadcrumb so the login screen can explain why the
    // session ended.
    if (reason === "idle") {
      try {
        sessionStorage.setItem("wayve-logout-reason", "idle");
      } catch {
        /* ignore */
      }
    }
    // Intentionally do NOT setUser(null) here. Nulling the user synchronously
    // re-renders the current (protected) route, which ProtectedRoute then
    // bounces to /login — a visible flash before the hard nav below lands on
    // "/". The hard reload to "/" resets all in-memory state anyway, and the
    // token is already cleared, so keeping `user` in place for the brief
    // logout-POST wait keeps the current page on screen instead of flashing
    // the login page. (Cookie clearing still happens via the awaited POST.)
    // Wait for the /api/logout response (which carries the cookie-clear
    // Set-Cookie) before navigating. The previous fire-and-forget shape
    // could hard-nav while the POST was still in flight; the browser
    // then aborted the request and never honored the Set-Cookie, so the
    // auth cookie kept living and re-authenticated the user on the next
    // page load. A 2-second cap means a slow/dead backend can't hang
    // the UI — the local state is already cleared, so we land on
    // /login either way.
    const logoutDone = logoutRequest().catch((err) =>
      log.error("logout request failed", err)
    );
    const timeout = new Promise<void>((resolve) =>
      window.setTimeout(resolve, 2000)
    );
    void Promise.race([logoutDone, timeout]).finally(() => {
      // Hard-nav so the user lands on a public page and all in-memory state is
      // reset. This runs only after the logout POST has either completed or hit
      // the 2s safety cap. In the desktop shell there is no marketing landing
      // page (the window opens straight to /login), so send the user back to
      // /login there; the browser keeps landing on the public "/" home. An idle
      // timeout also goes straight to /login (with the reason breadcrumb above).
      window.location.href =
        reason === "idle" || isDesktopApp() ? "/login" : "/";
    });
  };

  // Auto sign-out after 15 minutes of inactivity (shared across tabs). Only
  // armed while logged in; `logout("idle")` flags the reason for the login page.
  useIdleLogout(!!user, () => logout("idle"));

  // Re-fetch /api/me and overwrite the cached user. Used after server-side
  // mutations that change the caller's scope/permissions (e.g. a personal
  // user self-promoting to organization_admin via POST /api/organizations).
  const refresh = async () => {
    const token = getAuthToken();
    if (!token) return;
    const res = await getMe(token);
    if (!res.ok) {
      log.warn("refresh /api/me failed", { status: res.status });
      return;
    }
    const data = await res.json();
    setUser({
      email: data.email,
      id: data.id,
      username: data.username ?? null,
      account_type: normalizeAccountType(data.account_type),
      effective_role: data.effective_role ?? null,
      role_label: data.role_label ?? null,
      scope: data.scope ?? null,
      permissions: data.permissions ?? [],
      is_primary_owner: data.is_primary_owner ?? false,
      mode: data.mode === "admin" ? "admin" : "normal",
      can_switch_admin: data.can_switch_admin ?? false,
      organization_id: data.organization_id ?? null,
      organization_slug: data.organization_slug ?? null,
      organization_name: data.organization_name ?? null,
      current_plan: data.current_plan ?? null,
      recovery_mode: normalizeRecoveryMode(data.recovery_mode),
      theme_json: data.theme_json ?? null,
    });
  };

  // Switch the interactive session between normal and admin. The server mints a
  // fresh token carrying the new mode (and sets the auth cookie for hard
  // refresh); we swap the in-memory token and re-fetch /api/me so scope,
  // permissions and mode all update. Throws if the server refuses (e.g. a
  // non-owner requesting admin).
  const switchMode = async (target: "normal" | "admin") => {
    const res = await apiFetch("/api/session/mode", {
      method: "POST",
      preserve401: true,
      body: JSON.stringify({ mode: target }),
    });
    if (!res.ok) {
      throw new Error(`Failed to switch mode (${res.status})`);
    }
    const data = await res.json();
    if (data?.token) setAuthToken(data.token);
    await refresh();
  };

  return (
    <AuthContext.Provider
      value={{ user, initializing, login, logout, refresh, switchMode }}
    >
      {children}
      {pendingMnemonic && (
        <RecoverySeedModal
          mnemonic={pendingMnemonic}
          recoveryMode={pendingRecoveryMode}
          busy={wrapBusy}
          error={wrapError}
          onConfirmed={handleRecoveryConfirmed}
        />
      )}
      {needsRecovery && user && (
        <RecoverPromptModal
          userId={user.id}
          email={user.email}
          onUnlocked={() => setNeedsRecovery(false)}
          onLogout={logout}
        />
      )}
    </AuthContext.Provider>
  );
}
