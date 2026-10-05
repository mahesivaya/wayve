// The login credential the browser sends instead of the password.
//
// The password also derives the key that unlocks the user's private key (the
// login wrap, PBKDF2 under its own salt — see orgKeys/memberLogin.ts). If the
// server ever saw the password it could derive that key too, so the password
// never leaves the browser: we send
//   auth_key = PBKDF2-SHA256("wayve-auth-v1:" + password, auth_salt, 600k)
// and the server stores bcrypt(auth_key). Must match the backend's
// routes/auth_scheme.rs (sizes) — the server never derives this itself.
import { decodeBase64 } from "../orgKeys/envelopeCodec";
import { apiFetch } from "../api/client";

const AUTH_KDF_ITERATIONS = 600_000;
const AUTH_KDF_CONTEXT = "wayve-auth-v1:";
const AUTH_SALT_BYTES = 16;
const AUTH_KEY_BITS = 256;

export type DerivedCredential = { auth_salt: string; auth_key: string };

export type PreloginResult = { scheme: 1 | 2; auth_salt: string | null };

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function deriveAuthKey(
  password: string,
  saltB64: string,
  iterations: number = AUTH_KDF_ITERATIONS
): Promise<string> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_KDF_CONTEXT + password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: decodeBase64(saltB64).slice().buffer,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    AUTH_KEY_BITS
  );
  return bytesToB64(new Uint8Array(bits));
}

// A fresh salt + key for setting a new password (register, change, reset).
export async function newCredential(
  password: string
): Promise<DerivedCredential> {
  const auth_salt = bytesToB64(
    crypto.getRandomValues(new Uint8Array(AUTH_SALT_BYTES))
  );
  return { auth_salt, auth_key: await deriveAuthKey(password, auth_salt) };
}

export async function prelogin(email: string): Promise<PreloginResult> {
  const res = await apiFetch("/api/auth/prelogin", {
    auth: false,
    method: "POST",
    body: JSON.stringify({ email }),
  });
  const data = (await res.json()) as PreloginResult;
  if (data.scheme !== 1 && data.scheme !== 2) {
    throw new Error("Unexpected prelogin response");
  }
  return data;
}

// Thrown instead of sending a password the server asked for in legacy form
// after this browser already used the auth-key scheme for that identifier.
export class AuthDowngradeError extends Error {
  constructor() {
    super(
      "The server asked for your password in a less secure form than before, so it wasn't sent. Please contact your administrator."
    );
    this.name = "AuthDowngradeError";
  }
}

// Downgrade guard: once this browser has logged an identifier in with an auth
// key, a later prelogin claiming "legacy, send the password" is refused rather
// than trusted — that answer is exactly what a tampered server would give.
const v2Marker = (identifier: string) =>
  `wayve.auth.v2:${identifier.trim().toLowerCase()}`;

export function rememberAuthKeyScheme(identifier: string): void {
  try {
    localStorage.setItem(v2Marker(identifier), "1");
  } catch {
    // Storage unavailable (private mode): the guard is best-effort.
  }
}

export function expectsAuthKeyScheme(identifier: string): boolean {
  try {
    return localStorage.getItem(v2Marker(identifier)) === "1";
  } catch {
    return false;
  }
}
