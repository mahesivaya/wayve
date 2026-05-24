import { useEffect, useRef, useState } from "react";
import {
  savePrivateKey,
  savePublicKey,
  loadPrivateKey,
  loadPublicKey,
} from "../crypto/keyStore";
import { generateMnemonic, mnemonicToEntropy } from "../crypto/mnemonic";
import {
  wrapKeysForRecovery,
  wrapCredentialForRecovery,
} from "../crypto/recovery";
import {
  uploadWrappedKey,
  fetchBasicKey,
  uploadBasicKey,
} from "../api/recovery";
import RecoverySeedModal from "../recovery/RecoverySeedModal";
import { getMe, logout as logoutRequest, saveUserPublicKey } from "../api/Auth";
import { clearAuthToken, getAuthToken, setAuthToken } from "./token";
import { logger } from "../utils/logger";
import { normalizeAccountType } from "./accountHome";
import { permissionsForRole } from "./permissions";
import {
  AuthContext,
  type RecoveryMode,
  type UserType,
} from "./authContextValue";

const normalizeRecoveryMode = (value: unknown): RecoveryMode =>
  value === "basic" ? "basic"
    : value === "password_only" ? "password_only"
    : "full";

const log = logger.scope("auth");

type Claims = {
  sub: number;
  email: string;
  account_type?: string;
  organization_id?: number | null;
  exp?: number;
};

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized.padEnd(normalized.length + padding, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

// Decode JWT payload. Returns null on malformed/expired tokens so callers
// can treat a stale token the same as no token.
const parseJwt = (token: string): Claims | null => {
  try {
    const claims = JSON.parse(decodeBase64Url(token.split(".")[1])) as Claims;
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
};

// Resolve the boot-time token: prefer the OAuth redirect token from the URL
// fragment, otherwise reuse the stored one. The fragment keeps the token out of
// server logs, referrers, and browser request history.
const resolveBootToken = (): string | null => {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const tokenFromHash = hashParams.get("token");
  const isOAuthLanding =
    hashParams.has("signup") ||
    hashParams.has("connected") ||
    // SSO sign-in lands here with `#sso=true&token=...&new=true|false`.
    // Treated identically to the OAuth landings above so the token is
    // stored, the URL is cleaned, and the user enters /home in their
    // signed-in state.
    hashParams.has("sso");

  if (tokenFromHash && isOAuthLanding) {
    log.info("restoring token from OAuth redirect");
    setAuthToken(tokenFromHash);
    const path = window.location.pathname || "/home";
    window.history.replaceState(
      {},
      document.title,
      `${path}${window.location.search}`
    );
    return tokenFromHash;
  }

  return getAuthToken();
};

async function publishPublicKey(publicKey: ArrayBuffer) {
  await saveUserPublicKey(publicKey);
}

// Optimistic access guessed from account_type before /api/me confirms it. The
// JWT carries no role, so this assumes the top role for the account type; it is
// corrected the moment /api/me returns the server-computed permissions.
function defaultAccessForAccount(accountType?: string | null) {
  const normalized = normalizeAccountType(accountType);
  if (normalized === "platform_admin") {
    return {
      effective_role: "owner",
      role_label: "Platform owner",
      scope: "platform",
      permissions: permissionsForRole("owner"),
    };
  }
  if (normalized === "organization_admin") {
    return {
      effective_role: "owner",
      role_label: "Organization owner",
      scope: "organization",
      permissions: permissionsForRole("owner"),
    };
  }
  if (normalized === "organization") {
    return {
      effective_role: "member",
      role_label: "Member",
      scope: "organization",
      permissions: permissionsForRole("member"),
    };
  }
  return {
    effective_role: "owner",
    role_label: "Personal workspace owner",
    scope: "personal",
    permissions: permissionsForRole("owner"),
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const authVersion = useRef(0);

  // Optimistic init: trust a non-expired JWT immediately so the app renders
  // without a round-trip. /api/me below confirms it and logs us out on 401.
  const [user, setUser] = useState<UserType | null>(() => {
    const token = resolveBootToken();
    if (!token) return null;
    const claims = parseJwt(token);
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
  const [pendingWrapJob, setPendingWrapJob] = useState<(() => Promise<void>) | null>(null);
  // Track the user's recovery_mode at modal-open time so the seed-modal
  // copy can adapt (full = "restore on a new device too"; password_only
  // = "this resets a forgotten password only").
  const [pendingRecoveryMode, setPendingRecoveryMode] = useState<RecoveryMode>("full");
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapError, setWrapError] = useState<string | null>(null);

  // No `needsRestore` banner here anymore. On a "new device" (no local
  // key, server envelope present) the user can navigate to /recover on
  // their own — auto-nagging caused too many false positives in dev
  // (port switching) and confused real users. Lazy restore wins.

  // Basic mode (server-trust tier): the server holds an at-rest-
  // encrypted copy of the RSA private key. On a new device or freshly-
  // wiped IndexedDB we fetch the plaintext PKCS8 over TLS and load it
  // locally. On first login after registration the server has nothing
  // yet, so we generate a keypair, save locally, and upload the PKCS8
  // for future logins. No mnemonic ceremony at all in this mode.
  const setupBasicEncryption = async (userId: number) => {
    const serverPkcs8 = await fetchBasicKey().catch((err) => {
      log.warn("basic-key fetch failed", err);
      return null;
    });

    if (serverPkcs8) {
      log.info("basic: importing server-held private key");
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        serverPkcs8,
        { name: "RSA-OAEP", hash: "SHA-256" },
        true,
        ["decrypt"]
      );
      // Re-derive the SPKI public key from the imported private key by
      // exporting/importing the JWK form — WebCrypto can't extract a
      // public key directly from a private CryptoKey, but the JWK round-
      // trip yields a usable RSA-OAEP encrypt key.
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
      const publicKey = await crypto.subtle.exportKey("spki", publicCryptoKey);

      await savePrivateKey(privateKey, userId);
      await savePublicKey(publicKey, userId);
      await publishPublicKey(publicKey);
      return;
    }

    log.info("basic: no server-held key — generating + uploading fresh keypair");
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
    await savePrivateKey(keyPair.privateKey, userId);
    const publicKey = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    await savePublicKey(publicKey, userId);
    await publishPublicKey(publicKey);

    // Upload the PKCS8 plaintext to the server. Best-effort: failure
    // here means cross-device login won't work yet, but local
    // encryption is fine. Surface the error in the log and continue.
    try {
      const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
      await uploadBasicKey(pkcs8);
      log.info("basic: PKCS8 uploaded to /api/me/basic-key");
    } catch (err) {
      log.error("basic: PKCS8 upload failed; cross-device login will not work until next setup", err);
    }
  };

  const setupEncryption = async (userId: number, recoveryMode: RecoveryMode) => {
    try {
      const existingKey = await loadPrivateKey(userId);
      const existingPublicKey = await loadPublicKey(userId);

      if (existingKey && existingPublicKey) {
        await publishPublicKey(existingPublicKey);
        log.debug("encryption key already in IndexedDB; public key refreshed");
        return;
      }

      // No local key. The recovery_mode chosen at signup decides what
      // happens next.
      //
      // basic            → server holds an at-rest-encrypted copy of the
      //                    private key. Try to fetch it; if absent (first
      //                    login after register), generate fresh + upload.
      //                    No mnemonic, no seed modal.
      // full             → generate fresh keys, wrap the real private key
      //                    with a mnemonic, upload the envelope, show
      //                    the seed modal.
      // password_only    → generate fresh keys, wrap a random throwaway
      //                    payload with a mnemonic (just a credential
      //                    for /recover-with-mnemonic), upload, show
      //                    the seed modal.

      if (recoveryMode === "basic") {
        await setupBasicEncryption(userId);
        return;
      }

      log.info("generating new RSA key pair", { recoveryMode });

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

      await savePrivateKey(keyPair.privateKey, userId);

      const publicKey = await crypto.subtle.exportKey("spki", keyPair.publicKey);
      await savePublicKey(publicKey, userId);

      await publishPublicKey(publicKey);

      // Generate a recovery mnemonic, prepare the wrap closure, and let
      // the modal drive the rest. Critical: we generate the mnemonic
      // here (in the browser) and only the user ever sees it.
      const mnemonic = await generateMnemonic();
      const wrapJob = async () => {
        const entropy = await mnemonicToEntropy(mnemonic);
        const envelope =
          recoveryMode === "password_only"
            ? await wrapCredentialForRecovery(publicKey, entropy)
            : await wrapKeysForRecovery(keyPair.privateKey, publicKey, entropy);
        await uploadWrappedKey(envelope);
      };

      setPendingWrapJob(() => wrapJob);
      setPendingRecoveryMode(recoveryMode);
      setPendingMnemonic(mnemonic);

      log.info("encryption setup complete; awaiting recovery-seed confirmation", {
        recoveryMode,
      });
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

    (async () => {
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
          organization_id: data.organization_id ?? null,
          organization_slug: data.organization_slug ?? null,
          organization_name: data.organization_name ?? null,
          current_plan: data.current_plan ?? null,
          recovery_mode: normalizeRecoveryMode(data.recovery_mode),
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
          // Plan changes (upgrade / downgrade / new subscription) need to
          // trigger a re-render so the tier badge + Upgrade affordance
          // refresh. Comparing the `code` is enough — other plan fields
          // only change when `code` does.
          (prev.current_plan?.code ?? null) === (nextUser.current_plan?.code ?? null)
            ? prev
            : nextUser
        );

        setupEncryption(nextUser.id, nextUser.recovery_mode ?? "full").catch(
          (err) => log.error("background encryption setup failed", err)
        );
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

  const login = (token: string, accountType?: string) => {
    authVersion.current += 1;
    setAuthToken(token);
    setInitializing(false);

    const decoded = parseJwt(token);

    if (decoded) {
      const normalizedAccountType = normalizeAccountType(accountType ?? decoded.account_type);
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
            organization_id: data.organization_id ?? null,
            organization_slug: data.organization_slug ?? null,
            organization_name: data.organization_name ?? null,
            current_plan: data.current_plan ?? null,
            recovery_mode: recoveryMode,
          });
          setupEncryption(decoded.sub, recoveryMode).catch((err) =>
            log.error("background encryption setup failed", err)
          );
        })
        .catch((err) => log.error("post-login profile fetch failed", err));
    }
  };

  const logout = () => {
    authVersion.current += 1;
    clearAuthToken();
    setUser(null);
    logoutRequest().catch((err) => log.error("logout request failed", err));
    window.location.href = "/";
  };

  return (
    <AuthContext.Provider value={{ user, initializing, login, logout }}>
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
    </AuthContext.Provider>
  );
}
