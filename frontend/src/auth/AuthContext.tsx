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
import { getFontConfig } from "../api/platformUi";
import {
  applyPlatformFont,
  cacheFontKey,
  clearFontCache,
} from "../theme/platformFonts";
import { runtimeConfig } from "../config/runtimeConfig";
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

// Only one RecoveryMode ("full") exists now; this collapses any older
// /api/me payload from a partially-migrated deployment onto it.
const normalizeRecoveryMode = (_value: unknown): RecoveryMode => "full";

const log = logger.scope("auth");

async function publishPublicKey(publicKey: ArrayBuffer) {
  await saveUserPublicKey(publicKey);
}

// Must stay equal to the backend's org-member login-wrap iteration count
// (ORG_MEMBER_PBKDF2_ITERATIONS in encryption.rs) or wraps won't unwrap.
const LOGIN_WRAP_PBKDF2_ITERATIONS = 600_000;

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Wrap the user's PKCS8 private key under PBKDF2(password) and PUT it to
// /api/me/login-wrap, so the same user auto-unlocks on a new browser by
// re-deriving the AES key from their typed password. Without this they
// would need the 24-word mnemonic on every new device.
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

  // Zero the plaintext PKCS8 bytes. Best-effort only: JS cannot guarantee
  // the runtime did not already copy the buffer elsewhere.
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

  // Captured once at mount: resolveBootToken clears the URL hash as a side
  // effect, so the `signup` / `sso&new=true` markers are already gone by the
  // time the bootstrap effect runs.
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

  // Setting `pendingMnemonic` renders the seed modal. `pendingWrapJob` is the
  // closure that modal calls only after the user confirms they wrote the words
  // down; wrapping the private key and uploading the envelope happen THEN, so a
  // user who abandons the modal never gets a recovery copy they don't know about.
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);
  const [pendingWrapJob, setPendingWrapJob] = useState<
    (() => Promise<void>) | null
  >(null);
  const [pendingRecoveryMode, setPendingRecoveryMode] =
    useState<RecoveryMode>("full");
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapError, setWrapError] = useState<string | null>(null);
  // True when a user logs in on a device with no local encryption keys. Blocks
  // the UI behind RecoverPromptModal until they enter the 24-word phrase that
  // was shown to them exactly once at registration.
  const [needsRecovery, setNeedsRecovery] = useState(false);

  // WebCrypto cannot extract a public CryptoKey from a private one, but
  // exporting the private key to JWK and re-importing the public half of it
  // yields a usable encrypt key. Returns the SPKI bytes that savePublicKey and
  // publishPublicKey expect.
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

  // Encryption bootstrap. Branches only on what state this device and the
  // server are in:
  //
  //   1. The keypair is already in local IndexedDB: republish the public key.
  //   2. No local key but a wrapped envelope is on the server: another device
  //      set this user up, so prompt for the 24 words rather than regenerate.
  //   3. No local key and no envelope, but a legacy server-held `basic-key`
  //      PKCS8 blob exists: migrate it onto a fresh mnemonic wrap.
  //   4. Nothing anywhere: fresh signup, so generate a keypair and a mnemonic.
  const setupEncryption = async (
    userId: number,
    _recoveryMode: RecoveryMode,
    email: string,
    isFreshRegistration: boolean,
    // Used once to derive the PBKDF2 login-wrap. Lives only on this stack
    // frame; never stored or logged.
    plaintextPassword?: string
  ) => {
    try {
      // Ask the browser not to evict the keystore, so the cached keypair
      // survives a hard refresh and we don't re-prompt for the mnemonic.
      // Fire-and-forget; it must never block encryption setup.
      void requestPersistentStorage();

      // (1) A fresh registration wants brand-new keys even if IndexedDB holds
      // stale entries from a prior session. Short-circuiting here would skip
      // the seed modal and leave the user with keys that don't match the
      // server's new wrapped envelope.
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

      // (2) A wrapped envelope already exists server-side. We must NOT
      // regenerate, or the user's original mnemonic would be orphaned and the
      // data it protects unrecoverable.
      if (!isFreshRegistration) {
        const serverWrapped = await fetchWrappedKey();
        if (serverWrapped) {
          log.info("encryption keys missing — prompting for recovery mnemonic");
          setNeedsRecovery(true);
          return;
        }
      }

      // (3) Legacy user whose RSA private key still lives on the server as
      // `users.private_key_encrypted`. Pull it once, wrap it under a fresh
      // mnemonic, then delete the server copy so the mnemonic becomes the only
      // recovery path. The user must save the 24 words; there is no second chance.
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
            // Only once the wrap is on file, drop the legacy server-held PKCS8
            // envelope. A failed delete is non-fatal: the wrap is already
            // uploaded and a future login retries the DELETE.
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

      // (4) Fresh setup: a brand-new signup, or a seeded account on its first
      // login with no envelope anywhere.
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

      // Password-derived login wrap: AES-256-GCM(PBKDF2-SHA256-600k(password))
      // over the private key's PKCS8 bytes, so the user can sign in from a new
      // browser without the 24-word phrase. The mnemonic path below remains the
      // forgot-password fallback. When there is no password (SSO, legacy
      // callers) we skip silently and the user keeps the mnemonic-only flow.
      if (plaintextPassword) {
        try {
          await uploadPasswordLoginWrap(keyPair.privateKey, plaintextPassword);
          log.info("password login-wrap uploaded");
        } catch (err) {
          log.warn("password login-wrap upload failed (non-fatal)", err);
        }
      }

      // The mnemonic is generated in the browser and only the user ever sees it.
      // The wrap closure runs only after they confirm they saved the 24 words.
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

    // AbortController makes StrictMode's dev double-mount cancel the first
    // request instead of racing it.
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
          // No hard redirect: ProtectedRoute already sends unauthenticated users
          // away from protected pages, and public pages must stay rendered.
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
        // Only patch state if the server sees a different user, so the
        // optimistic claims don't trigger a pointless re-render.
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
          // A plan change must re-render so the tier badge and Upgrade
          // affordance refresh. Comparing `code` suffices: the other plan
          // fields only change when it does.
          (prev.current_plan?.code ?? null) ===
            (nextUser.current_plan?.code ?? null)
            ? prev
            : nextUser
        );

        // This effect normally runs for already-signed-in users, so
        // isFreshRegistration is false. The exception is a Google/SSO landing
        // whose URL hash carried `signup=true`: those users skip Register.tsx
        // and would otherwise be asked for a phrase they were never given.
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
    // `setupEncryption` is deliberately omitted from the deps: it is unmemoized,
    // so listing it would re-run the whole auth bootstrap on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = (
    token: string,
    accountType?: string,
    isFreshRegistration = false,
    // Forwarded from the login/register form and used once in `setupEncryption`
    // to compute the PBKDF2 login-wrap of the new RSA private key. Never
    // persisted, never logged.
    plaintextPassword?: string
  ) => {
    authVersion.current += 1;
    setAuthToken(token);
    // Start every session with the sidebar expanded ("0"); Layout reads this on
    // mount. Best-effort: private mode just no-ops, and expanded is the default.
    try {
      localStorage.setItem("rwayve.sidebar.collapsed", "0");
    } catch {
      // Storage unavailable; Layout falls back to expanded.
    }
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
      // The mount-time /api/me effect has already run by now, so a fresh login
      // needs its own profile fetch to learn the org slug/name that drive
      // organization routing.
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

  // Soft session-expiry: the API client dispatches `rwayve:session-expired` on a
  // 401 rather than hard-reloading. Dropping the user locally lets ProtectedRoute
  // redirect in-app, with no full-page blink.
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
    // Drop the cached per-user font so the next user starts from the platform
    // default rather than this one's resolved font.
    clearFontCache();
    // An explicit logout means "I am leaving this machine", so wipe the cached
    // E2E keys and don't leave the private key in IndexedDB on a shared device.
    // Session-expiry deliberately does NOT do this, so re-login stays
    // prompt-free.
    void clearKeys();
    setNeedsRecovery(false);
    if (reason === "idle") {
      try {
        sessionStorage.setItem("wayve-logout-reason", "idle");
      } catch {
        /* ignore */
      }
    }
    // Deliberately no setUser(null): that would re-render the protected route
    // and flash ProtectedRoute's /login bounce before the hard nav below lands.
    // The token is already cleared and the reload resets in-memory state anyway.
    //
    // Navigating must wait for the /api/logout response, which carries the
    // cookie-clearing Set-Cookie: aborting it mid-flight leaves a stale auth
    // cookie that re-authenticates the user on the next page load. The 2s cap
    // stops a dead backend from hanging the UI.
    const logoutDone = logoutRequest().catch((err) =>
      log.error("logout request failed", err)
    );
    const timeout = new Promise<void>((resolve) =>
      window.setTimeout(resolve, 2000)
    );
    void Promise.race([logoutDone, timeout]).finally(() => {
      // Hard-nav so all in-memory state is reset. The desktop shell has no
      // marketing landing page, so it goes to /login; the browser lands on the
      // public home. An idle timeout also goes straight to /login.
      window.location.href =
        reason === "idle" || isDesktopApp() ? "/login" : "/";
    });
  };

  // Auto sign-out after 15 minutes of inactivity, shared across tabs.
  useIdleLogout(!!user, () => logout("idle"));

  // Apply the caller's resolved font (own > org > platform default) once the
  // session is known, and cache it so the next boot doesn't flash.
  useEffect(() => {
    let cancelled = false;
    if (user) {
      void getFontConfig()
        .then((cfg) => {
          if (cancelled) return;
          cacheFontKey(cfg.resolved);
          applyPlatformFont(cfg.resolved);
        })
        .catch(() => {});
    } else {
      applyPlatformFont(runtimeConfig().fontKey);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  // Used after server-side mutations that change the caller's scope or
  // permissions, such as a personal user self-promoting to organization_admin.
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

  // The server mints a fresh token carrying the new mode; we swap the in-memory
  // token and re-fetch /api/me so scope, permissions and mode all update. Throws
  // if the server refuses, for example a non-owner requesting admin.
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
