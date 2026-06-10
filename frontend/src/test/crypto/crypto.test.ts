// @vitest-environment node
//
// Round-trip tests for the browser crypto helpers. These run in the `node`
// environment on purpose: jsdom does not implement WebCrypto's SubtleCrypto,
// but Node 20's global `crypto` does — the same API the browser provides.
import { describe, it, expect } from "vitest";
import {
  generateKey,
  encrypt,
  decrypt,
  encryptMessage,
  decryptMessage,
} from "../../crypto/crypto";

describe("AES-GCM encrypt/decrypt", () => {
  it("round-trips plaintext (incl. unicode)", async () => {
    const key = await generateKey();
    const plaintext = "hello rwayve 🔐 — unicode ok";
    const enc = await encrypt(plaintext, key);
    expect(enc.iv).toBeTruthy();
    expect(enc.data).not.toBe(plaintext);
    expect(await decrypt(enc, key)).toBe(plaintext);
  });

  it("uses a fresh iv + ciphertext on every call", async () => {
    const key = await generateKey();
    const a = await encrypt("same input", key);
    const b = await encrypt("same input", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("fails to decrypt with the wrong key", async () => {
    const enc = await encrypt("secret", await generateKey());
    await expect(decrypt(enc, await generateKey())).rejects.toBeDefined();
  });
});

describe("RSA-OAEP + AES hybrid envelope", () => {
  async function rsaPair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"]
    );
  }

  it("round-trips a message through encryptMessage/decryptMessage", async () => {
    const pair = await rsaPair();
    const message = "hybrid envelope payload";
    const { encryptedMessage, encryptedKey, iv } = await encryptMessage(
      message,
      pair.publicKey
    );
    const out = await decryptMessage(
      encryptedMessage,
      encryptedKey,
      iv,
      pair.privateKey
    );
    expect(out).toBe(message);
  });

  it("cannot be decrypted with a different recipient's private key", async () => {
    const recipient = await rsaPair();
    const attacker = await rsaPair();
    const { encryptedMessage, encryptedKey, iv } = await encryptMessage(
      "for the right recipient only",
      recipient.publicKey
    );
    await expect(
      decryptMessage(encryptedMessage, encryptedKey, iv, attacker.privateKey)
    ).rejects.toBeDefined();
  });
});
