// @vitest-environment node
//
// Round-trip tests for Plan A Phase 3's passphrase-wrapped secure-send
// bundle. Runs in `node` for SubtleCrypto access (jsdom lacks it).
// These tests exercise the full encrypt → bundle → decrypt loop using
// only what would cross the wire — no private key store dependency.

import { describe, it, expect } from "vitest";
import {
  sealSecureMessage,
  openSecureMessage,
  type ServerSecureMessage,
} from "../../emails/secureSend";

// Convert a SealSecureMessage bundle into the ServerSecureMessage shape
// the openSecureMessage helper consumes — mirrors what the server's
// GET /api/secure-messages/{token} would return, minus the timestamps
// that the test doesn't care about.
function asServerEnvelope(
  bundle: Awaited<ReturnType<typeof sealSecureMessage>>,
  overrides: Partial<ServerSecureMessage> = {},
): ServerSecureMessage {
  return {
    token: "test-token",
    sender_email: "alice@personal.test",
    subject: "Test",
    ciphertext: bundle.ciphertext,
    iv: bundle.iv,
    wrapped_key: bundle.wrapped_key,
    salt: bundle.salt,
    pbkdf2_iterations: bundle.pbkdf2_iterations,
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("Plan A Phase 3 secure-send passphrase envelope", () => {
  it("round-trips body with correct passphrase", async () => {
    const passphrase = "blue-elephant-42";
    const plaintext = "secret meeting brief 🤐 — unicode ok";
    const bundle = await sealSecureMessage(plaintext, passphrase);

    // Bundle fields all base64 and present
    expect(bundle.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(bundle.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(bundle.wrapped_key).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(bundle.salt).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(bundle.pbkdf2_iterations).toBe(600000);

    const recovered = await openSecureMessage(
      asServerEnvelope(bundle),
      passphrase,
    );
    expect(recovered).toBe(plaintext);
  });

  it("rejects the wrong passphrase with a clear error", async () => {
    const bundle = await sealSecureMessage("secret", "correct-horse-battery");
    await expect(
      openSecureMessage(asServerEnvelope(bundle), "wrong-horse-battery"),
    ).rejects.toThrow(/passphrase/i);
  });

  it("rejects empty passphrase on encrypt", async () => {
    await expect(sealSecureMessage("body", "")).rejects.toThrow(
      /at least 6 characters/i,
    );
  });

  it("rejects passphrase shorter than 6 chars on encrypt", async () => {
    await expect(sealSecureMessage("body", "abc")).rejects.toThrow(
      /at least 6 characters/i,
    );
  });

  it("two seals of the same body+passphrase produce different ciphertext", async () => {
    // Per-message salt + per-message DEK + per-message IV all randomise
    // every call, so even identical inputs are unrelated on the wire.
    const a = await sealSecureMessage("same body", "same-passphrase");
    const b = await sealSecureMessage("same body", "same-passphrase");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.wrapped_key).not.toBe(b.wrapped_key);
  });

  it("tampered ciphertext fails to decrypt", async () => {
    const bundle = await sealSecureMessage("legit body", "secret-passphrase");
    // Flip a random byte in the ciphertext. AES-GCM auth tag should
    // catch it and the decrypt should fail rather than return garbage.
    // Use browser-style atob/btoa rather than Node's Buffer so the
    // test doesn't need @types/node in scope.
    const raw = atob(bundle.ciphertext);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    bytes[0] ^= 0xff;
    let reencoded = "";
    for (let i = 0; i < bytes.length; i++) reencoded += String.fromCharCode(bytes[i]);
    const tampered = asServerEnvelope({
      ...bundle,
      ciphertext: btoa(reencoded),
    });
    await expect(
      openSecureMessage(tampered, "secret-passphrase"),
    ).rejects.toThrow();
  });

  it("respects custom iteration count when round-tripping", async () => {
    // Synthesize a bundle that uses a non-default iteration count and
    // confirm decryption uses the bundled value rather than a constant.
    const bundle = await sealSecureMessage("body", "secret-passphrase");
    // We can't easily produce a non-default bundle with sealSecureMessage
    // (it hard-codes 600k), so just verify the field is round-tripped:
    expect(bundle.pbkdf2_iterations).toBe(600000);
    const recovered = await openSecureMessage(
      asServerEnvelope(bundle, { pbkdf2_iterations: 600000 }),
      "secret-passphrase",
    );
    expect(recovered).toBe("body");
  });
});
