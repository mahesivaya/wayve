// @vitest-environment node
//
// Round-trip tests for Plan A Phase 2's multi-recipient email envelope.
// Runs in the `node` environment for SubtleCrypto access (jsdom lacks it,
// and node 20+ provides the same API). We deliberately do NOT go through
// `bodyUtils.decryptWayveBodyIfNeeded` here because that helper reaches
// into IndexedDB via `loadPrivateKey`, which isn't available in node
// without a fake-indexeddb polyfill. Instead we exercise the wire format
// directly: build envelope → parse JSON → manually unwrap one recipient
// slot with the matching private key → confirm plaintext matches. A
// regression in the JSON shape, prefix line, key encoding, or AES/RSA
// primitives would fail this test before any end-to-end flow runs.

import { describe, it, expect } from "vitest";
import { buildInternalEnvelope } from "../../emails/internalEnvelope";

const ENVELOPE_PREFIX = "WAYVE_SECURE_V1\n";

async function generateRecipient(userId: number) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return {
    userId,
    publicKeyBytes: Array.from(new Uint8Array(spki)),
    privateKey: keyPair.privateKey,
  };
}

// Mirror of what bodyUtils.ts does on decode, minus the IndexedDB
// private-key lookup — we already have the CryptoKey in hand.
async function decryptEnvelopeFor(envelope: string, userId: number, privateKey: CryptoKey) {
  expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true);
  const parsed = JSON.parse(envelope.slice(ENVELOPE_PREFIX.length));
  expect(parsed.type).toBe("wayve_encrypted_multi");

  const wrappedKey = parsed.keys[String(userId)] as number[] | undefined;
  if (!wrappedKey) throw new Error("no wrapped key for this user");

  const rawAes = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    new Uint8Array(wrappedKey),
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintextBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(parsed.iv) },
    aesKey,
    new Uint8Array(parsed.data),
  );
  return new TextDecoder().decode(plaintextBytes);
}

describe("Plan A Phase 2 multi-recipient envelope", () => {
  it("encodes to WAYVE_SECURE_V1 and round-trips for each recipient", async () => {
    const alice = await generateRecipient(101);
    const bob = await generateRecipient(202);
    const plaintext = "secret meeting brief 🤐 — unicode + emoji";

    const envelope = await buildInternalEnvelope(plaintext, [
      { userId: alice.userId, publicKeyBytes: alice.publicKeyBytes },
      { userId: bob.userId, publicKeyBytes: bob.publicKeyBytes },
    ]);

    // Wire-format guarantees the bodyUtils decoder hard-codes:
    expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true);
    const parsed = JSON.parse(envelope.slice(ENVELOPE_PREFIX.length));
    expect(parsed.type).toBe("wayve_encrypted_multi");
    expect(parsed.iv).toHaveLength(12);
    expect(Object.keys(parsed.keys).sort()).toEqual(["101", "202"]);

    // Each recipient's slot independently decrypts to the same body.
    expect(await decryptEnvelopeFor(envelope, alice.userId, alice.privateKey))
      .toBe(plaintext);
    expect(await decryptEnvelopeFor(envelope, bob.userId, bob.privateKey))
      .toBe(plaintext);
  });

  it("interloper not in the envelope cannot decrypt", async () => {
    const recipient = await generateRecipient(303);
    const interloper = await generateRecipient(404);
    const envelope = await buildInternalEnvelope("private", [
      { userId: recipient.userId, publicKeyBytes: recipient.publicKeyBytes },
    ]);

    await expect(
      decryptEnvelopeFor(envelope, interloper.userId, interloper.privateKey),
    ).rejects.toThrow(/no wrapped key/i);
  });

  it("non-determinism — same plaintext + recipients produce different ciphertext", async () => {
    const alice = await generateRecipient(505);
    const a = await buildInternalEnvelope("same body", [
      { userId: alice.userId, publicKeyBytes: alice.publicKeyBytes },
    ]);
    const b = await buildInternalEnvelope("same body", [
      { userId: alice.userId, publicKeyBytes: alice.publicKeyBytes },
    ]);
    expect(a).not.toBe(b);
  });

  it("refuses to build an envelope with zero recipients", async () => {
    await expect(buildInternalEnvelope("nope", [])).rejects.toThrow(
      /at least one recipient/i,
    );
  });
});
