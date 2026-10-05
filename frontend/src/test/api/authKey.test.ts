// @vitest-environment node
//
// Node's environment, like the other WebCrypto tests (crypto.test.ts,
// envelopeCodec.test.ts): under jsdom, typed arrays come from jsdom's realm and
// Node's SubtleCrypto (Node 20, as in CI) rejects them as PBKDF2 salts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changePassword, login } from "../../api/Auth";
import { deriveAuthKey } from "../../auth/authKey";

// The password must never cross the wire. These tests read every request body
// the auth calls send and check for the raw password.
const PASSWORD = "correct horse battery staple";
const SALT = btoa(String.fromCharCode(...new Uint8Array(16).fill(7)));

type Sent = { url: string; body: Record<string, unknown> };

function stubServer(prelogin: { scheme: 1 | 2; auth_salt: string | null }) {
  const sent: Sent[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    sent.push({ url, body });
    const payload = url.endsWith("/api/auth/prelogin")
      ? prelogin
      : url.endsWith("/api/login")
        ? { token: "jwt", account_type: "personal" }
        : { message: "ok" };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      clone() {
        return this;
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return sent;
}

const leaksPassword = (sent: Sent[]) =>
  sent.some((s) => JSON.stringify(s.body).includes(PASSWORD));

describe("auth key derivation", () => {
  it("matches PBKDF2-SHA256 over the context-prefixed password", async () => {
    // Reference value from Node's independent implementation:
    //   crypto.pbkdf2Sync("wayve-auth-v1:" + PASSWORD, 16 bytes of 7, 1000, 32,
    //   "sha256").toString("base64")
    // A low iteration count keeps the test fast; production only changes the
    // count, not the algorithm.
    const expected = "85Qk5z/+hloVtWFW6Azfrd/8AfAwI1bsxmTFJ4ACD4U=";
    await expect(deriveAuthKey(PASSWORD, SALT, 1000)).resolves.toBe(expected);
  });
});

describe("login / change password never send the raw password", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("scheme 2: sends only the derived auth key", async () => {
    const sent = stubServer({ scheme: 2, auth_salt: SALT });
    await login("a@b.c", PASSWORD);

    const loginBody = sent.find((s) => s.url.endsWith("/api/login"))?.body;
    expect(loginBody).toEqual({
      email: "a@b.c",
      auth_key: await deriveAuthKey(PASSWORD, SALT),
    });
    expect(leaksPassword(sent)).toBe(false);
  });

  it("scheme 1: sends the password once, with an upgrade credential", async () => {
    const sent = stubServer({ scheme: 1, auth_salt: null });
    await login("a@b.c", PASSWORD);

    const loginBody = sent.find((s) => s.url.endsWith("/api/login"))?.body;
    expect(loginBody?.password).toBe(PASSWORD);
    const upgrade = loginBody?.upgrade as {
      auth_salt: string;
      auth_key: string;
    };
    expect(upgrade.auth_key).toBe(
      await deriveAuthKey(PASSWORD, upgrade.auth_salt)
    );
  });

  it("refuses to downgrade an identifier that already used scheme 2", async () => {
    stubServer({ scheme: 2, auth_salt: SALT });
    await login("a@b.c", PASSWORD);

    const sent = stubServer({ scheme: 1, auth_salt: null });
    await expect(login("a@b.c", PASSWORD)).rejects.toThrow(/less secure/);
    expect(sent.some((s) => s.url.endsWith("/api/login"))).toBe(false);
    expect(leaksPassword(sent)).toBe(false);
  });

  it("change password proves the current one with the auth key", async () => {
    const sent = stubServer({ scheme: 2, auth_salt: SALT });
    await changePassword("a@b.c", PASSWORD, "a-new-password-1");

    const body = sent.find((s) =>
      s.url.endsWith("/api/profile/password")
    )?.body;
    expect(body?.current_auth_key).toBe(await deriveAuthKey(PASSWORD, SALT));
    expect(body).not.toHaveProperty("current_password");
    expect(body).not.toHaveProperty("new_password");
    expect(JSON.stringify(body)).not.toContain("a-new-password-1");
    expect(leaksPassword(sent)).toBe(false);
  });
});
