import { logger } from "../utils/logger";
import { getApiBase } from "../config/env";

const log = logger.scope("auth");
import { apiFetch } from "./client";

const newReqId = (): string => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && "randomUUID" in c) return c.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
};

export async function register(email: string, password: string, confirm: string) {
  const reqId = newReqId();
  log.info(`[${reqId}] register attempt`, { email });
  const start = performance.now();

  try {
    const res = await apiFetch("/api/register", {
      auth: false,
      method: "POST",
      headers: {
        "X-Request-ID": reqId,
      },
      body: JSON.stringify({ email, password, confirm_password: confirm }),
    });

    const ms = Math.round(performance.now() - start);
    const data = await res.json();
    log.info(`[${reqId}] register ok in ${ms}ms`,{ email });
    return data;
  }
  catch(err){
    log.warn(`[${reqId}] register failed`, {
      email,
      error:
          err instanceof Error
            ? err.message
            : "Unknown error",
    });
    throw err;
  }
}

export async function login(email: string, password: string) {
  const reqId = newReqId();
  log.info(`[${reqId}] login attempt`, { email });
  const start = performance.now();

  try {
    const res = await apiFetch(`/api/login`, {
      auth: false,
      preserve401: true,
      method: "POST",
      headers: {
        "X-Request-ID": reqId,
      },
      body: JSON.stringify({ email, password }),
    });

    const ms = Math.round(performance.now() - start);
    const data = await res.json();
    log.info(`[${reqId}] login ok in ${ms}ms`,{ email });

    return data;
  } catch (err) {
    log.error(`[${reqId}] login error`, err);
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
    body: JSON.stringify({ token,
      new_password: newPassword }),
  });
  return res.json();
}

export async function changePassword(
  currentPassword: string | null,
  newPassword: string
) {
  const body =
    currentPassword === null
      ? { new_password: newPassword }
      : {
          current_password: currentPassword,
          new_password: newPassword,
        };

  const res = await apiFetch(
    "/api/profile/password",
    {
      method: "POST",
      preserve401: true,
      body: JSON.stringify(body),
    }
  );
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
  });
}
