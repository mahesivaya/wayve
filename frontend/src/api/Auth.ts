import { logger } from "../utils/logger";
import { getApiBase } from "../config/env";

const log = logger.scope("auth");
import { apiFetch } from "./client";

const newReqId = (): string => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && "randomUUID" in c) return c.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
};

// Re-export from authContextValue so call sites can keep importing
// `RecoveryMode` from a single place. The canonical union is the one
// kept in sync with the backend CHECK constraint on `users.recovery_mode`.
export type { RecoveryMode } from "../auth/authContextValue";
import type { RecoveryMode as _RecoveryMode } from "../auth/authContextValue";

export async function register(
  email: string,
  password: string,
  confirm: string,
  recoveryMode: _RecoveryMode = "full"
) {
  const reqId = newReqId();
  log.info(`[${reqId}] register attempt`, { email, recoveryMode });
  const start = performance.now();

  try {
    const res = await apiFetch("/api/register", {
      auth: false,
      method: "POST",
      headers: {
        "X-Request-ID": reqId,
      },
      body: JSON.stringify({
        email,
        password,
        confirm_password: confirm,
        recovery_mode: recoveryMode,
      }),
    });

    const ms = Math.round(performance.now() - start);
    const data = await res.json();
    log.info(`[${reqId}] register ok in ${ms}ms`, { email });
    return data;
  } catch (err) {
    log.warn(`[${reqId}] register failed`, {
      email,
      error: err instanceof Error ? err.message : "Unknown error",
    });
    throw err;
  }
}

// Direct business signup — creates the owner account + organization in one
// step and returns { token, account_type: "organization_admin" }.
export async function registerBusiness(input: {
  organization_name: string;
  username: string;
  email: string;
  password: string;
  confirm_password: string;
}) {
  const res = await apiFetch("/api/register-business", {
    auth: false,
    method: "POST",
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function login(email: string, password: string) {
  const reqId = newReqId();
  log.info(`[${reqId}] login attempt`, { email });
  const start = performance.now();

  try {
    const res = await apiFetch(`/api/login`, {
      auth: false,
      preserve401: true,
      // Surface the 403 "email_unverified" body so the caller can prompt to
      // verify/resend instead of a generic failure.
      preserve403: true,
      method: "POST",
      headers: {
        "X-Request-ID": reqId,
      },
      body: JSON.stringify({ email, password }),
    });

    const ms = Math.round(performance.now() - start);
    const data = await res.json();
    log.info(`[${reqId}] login ok in ${ms}ms`, { email });

    return data;
  } catch (err) {
    log.warn(`[${reqId}] login failed`, {
      email,
      message: err instanceof Error ? err.message : "Login failed",
    });
    throw err;
  }
}

export async function forgotPassword(email: string) {
  const res = await apiFetch(`/api/forgot-password`, {
    auth: false,
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return res.json();
}

export async function resetPassword(token: string, newPassword: string) {
  const res = await apiFetch(`/api/reset-password`, {
    auth: false,
    method: "POST",
    body: JSON.stringify({ token, new_password: newPassword }),
  });
  return res.json();
}

// Confirm the 6-digit email-verification code sent to `email`.
export async function verifyEmail(email: string, code: string) {
  const res = await apiFetch(`/api/verify-email`, {
    auth: false,
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  return res.json();
}

// Re-send the verification link. Always resolves (generic 200) regardless of
// whether the address exists / is already verified.
export async function resendVerification(email: string) {
  const res = await apiFetch(`/api/resend-verification`, {
    auth: false,
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return res.json();
}

// Mnemonic-based password reset for users who lost their password but kept
// their 24-word recovery phrase. The phrase itself never crosses the wire;
// the frontend converts it to 32-byte entropy first (see crypto/mnemonic.ts
// :: mnemonicToEntropy). Backend verifies by attempting AES-GCM decrypt of
// the user's stored envelope and only mutates the password if that
// succeeds.
//
// For "full" accounts the response includes the envelope so the same page
// can also unlock E2E keys client-side. For "password_only" accounts
// `wrapped_envelope` is null — the server never held the user's real
// private key, so no client-side restore is possible.
export type RecoverWithMnemonicResponse = {
  user_id: number;
  recovery_mode?: _RecoveryMode;
  wrapped_envelope: {
    v: 1;
    iv: string;
    pub: string;
    ct: string;
  } | null;
};

export async function recoverWithMnemonic(
  email: string,
  mnemonicEntropy: Uint8Array,
  newPassword: string
): Promise<RecoverWithMnemonicResponse> {
  const entropyB64 = btoa(
    Array.from(mnemonicEntropy)
      .map((b) => String.fromCharCode(b))
      .join("")
  );
  const res = await apiFetch("/api/auth/recover-with-mnemonic", {
    auth: false,
    preserve401: true,
    method: "POST",
    body: JSON.stringify({
      email,
      mnemonic_entropy: entropyB64,
      new_password: newPassword,
    }),
  });
  return res.json();
}

export async function changePassword(
  currentPassword: string | null,
  newPassword: string,
  // Re-wrapped login envelope, required by the backend for any account that
  // has a member_login_wrapped_keys row (i.e. anyone who set up E2E keys).
  newLoginWrap?: {
    iv: string;
    ct: string;
    salt: string;
    iterations: number;
  } | null
) {
  const body: Record<string, unknown> =
    currentPassword === null
      ? { new_password: newPassword }
      : {
          current_password: currentPassword,
          new_password: newPassword,
        };
  if (newLoginWrap) {
    body.new_login_wrap = newLoginWrap;
  }

  const res = await apiFetch("/api/profile/password", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function saveUserPublicKey(publicKey: ArrayBuffer) {
  await apiFetch("/api/save-public-key", {
    method: "POST",
    body: JSON.stringify({
      public_key: Array.from(new Uint8Array(publicKey)),
    }),
  });
}

export async function getMe(token?: string | null, signal?: AbortSignal) {
  return fetch(`${getApiBase()}/api/me`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal,
  });
}

export async function logout() {
  await apiFetch("/api/logout", {
    method: "POST",
    preserve401: true,
  });
}
