// @vitest-environment node
//
// Round-trip tests for the org-key envelope codec. These cover the
// wrap-with-RSA-pubkey and unwrap-with-RSA-key shape that's used both
// for the founder's auto-load wrap (organization_wrapped_keys.user_pubkey)
// and the member escrow envelope's outer-shell.

import { describe, it, expect } from "vitest";
import {
  unwrapPkcs8WithPbkdf2,
  unwrapPkcs8WithRsaKey,
  wrapPkcs8ToRsaPubkey,
} from "../../orgKeys/envelopeCodec";

async function generateRsaKeypair() {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["wrapKey", "unwrapKey", "encrypt", "decrypt"]
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", kp.publicKey)
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", kp.privateKey)
  );
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    spkiBytes: spki.buffer,
    pkcs8: pkcs8.buffer,
  };
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("envelopeCodec — RSA-pubkey wrap of PKCS8", () => {
  it("wraps and unwraps a PKCS8 buffer through the recipient's RSA key", async () => {
    const orgKp = await generateRsaKeypair();
    const memberKp = await generateRsaKeypair();

    // Founder wraps the org PKCS8 to ANOTHER user's pubkey (e.g. a new
    // key-holder being added).
    const { iv, ct } = await wrapPkcs8ToRsaPubkey(
      orgKp.pkcs8,
      memberKp.spkiBytes
    );

    // Recipient unwraps with their RSA private key and gets back the
    // EXACT bytes of the PKCS8 they're authorized to use.
    const recovered = await unwrapPkcs8WithRsaKey(iv, ct, memberKp.privateKey);

    const a = new Uint8Array(orgKp.pkcs8);
    const b = new Uint8Array(recovered);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
  });

  it("rejects unwrap with a different recipient's private key", async () => {
    const orgKp = await generateRsaKeypair();
    const intendedRecipient = await generateRsaKeypair();
    const interloper = await generateRsaKeypair();

    const { iv, ct } = await wrapPkcs8ToRsaPubkey(
      orgKp.pkcs8,
      intendedRecipient.spkiBytes
    );
    await expect(
      unwrapPkcs8WithRsaKey(iv, ct, interloper.privateKey)
    ).rejects.toThrow();
  });

  it("two wraps of the same PKCS8 produce different iv/ct (non-deterministic)", async () => {
    const orgKp = await generateRsaKeypair();
    const recipientKp = await generateRsaKeypair();

    const a = await wrapPkcs8ToRsaPubkey(orgKp.pkcs8, recipientKp.spkiBytes);
    const b = await wrapPkcs8ToRsaPubkey(orgKp.pkcs8, recipientKp.spkiBytes);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("envelopeCodec — PBKDF2 wrap of PKCS8 (mnemonic + member-login)", () => {
  it("round-trips a PKCS8 through PBKDF2-derived AES-GCM key", async () => {
    const enc = new TextEncoder();
    const orgKp = await generateRsaKeypair();
    const input = enc.encode("any-input-material-32-bytes-or-more-for-pbkdf2");

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const baseKey = await crypto.subtle.importKey(
      "raw",
      input,
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt.slice().buffer,
        iterations: 600_000,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.slice().buffer },
      aesKey,
      orgKp.pkcs8
    );

    const recovered = await unwrapPkcs8WithPbkdf2(
      bytesToB64(iv),
      bytesToB64(new Uint8Array(ct)),
      input,
      bytesToB64(salt),
      600_000
    );

    const a = new Uint8Array(orgKp.pkcs8);
    const b = new Uint8Array(recovered);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
  });

  it("wrong input material fails to unwrap", async () => {
    const enc = new TextEncoder();
    const orgKp = await generateRsaKeypair();
    const right = enc.encode("correct-secret-key-input");
    const wrong = enc.encode("wrong-secret-key-input");

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const baseKey = await crypto.subtle.importKey(
      "raw",
      right,
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt.slice().buffer,
        iterations: 600_000,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.slice().buffer },
      aesKey,
      orgKp.pkcs8
    );

    await expect(
      unwrapPkcs8WithPbkdf2(
        bytesToB64(iv),
        bytesToB64(new Uint8Array(ct)),
        wrong,
        bytesToB64(salt),
        600_000
      )
    ).rejects.toThrow();
  });
});
