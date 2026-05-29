import { apiPost } from "./api";
import { resetRateLimits } from "./reset-rate-limits";

export type SeededUser = {
  email: string;
  password: string;
  token: string;
  accountType: string;
};

// Generate a unique email per test so parallel-or-sequential runs never
// collide. The "e2e+" prefix makes it trivial to clean up later via:
//   DELETE FROM users WHERE email LIKE 'e2e+%@test.local';
// (Not done automatically here — the suite is non-destructive on prod
// and intentionally leaks test users on the dev DB until reset.)
export function uniqueEmail(prefix = "e2e"): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}+${stamp}-${rand}@test.local`;
}

// Register a fresh local user and return the credential bundle. Uses
// `recovery_mode: "basic"` so we don't have to ferry a 24-word mnemonic
// through the test — the server escrows the wrapped private key and
// login works on any future device. Throws if the backend rejects.
export async function registerUser(opts?: {
  email?: string;
  password?: string;
}): Promise<SeededUser> {
  const email = opts?.email ?? uniqueEmail();
  const password = opts?.password ?? "E2eTest_2026!Strong";
  // Reset the per-IP `rl:*` counters before each register call. The
  // /api/register limit (5/300s) is meaningful for prod abuse but
  // makes a long E2E run impossible from a single localhost IP.
  // Flushing per call costs ~5ms (one Redis SCAN + DEL) — much
  // cheaper than the per-call backoff this used to do.
  await resetRateLimits();
  let lastResp: { status: number; body: unknown } = { status: 0, body: null };
  for (const wait of [0, 2_000, 5_000]) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastResp = await apiPost<{ token: string; account_type: string; message?: string }>(
      "/api/register",
      { email, password, confirm_password: password, recovery_mode: "basic" },
    );
    if (lastResp.status !== 429) break;
    // If we still saw 429, the flush probably raced or didn't reach
    // the right Redis. Try a fresh flush before the next retry.
    await resetRateLimits();
  }
  const body = lastResp.body as { token?: string; account_type?: string };
  if (lastResp.status !== 200 || !body?.token) {
    throw new Error(
      `register failed (${lastResp.status}): ${JSON.stringify(lastResp.body)}`,
    );
  }
  return { email, password, token: body.token, accountType: body.account_type ?? "personal" };
}

// Same as registerUser but lets the caller force a specific email — used
// by tests that need a known-bad address (e.g. duplicate-email rejection).
export async function tryRegister(email: string, password: string) {
  return apiPost<{ token?: string; account_type?: string; message?: string }>(
    "/api/register",
    { email, password, confirm_password: password, recovery_mode: "basic" },
  );
}
