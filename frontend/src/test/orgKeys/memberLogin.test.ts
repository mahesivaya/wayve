// @vitest-environment node
//
// Round-trip tests for the member-login + password-change flows. Skips
// the IndexedDB caching side of unwrapAndCacheMemberKeys (jsdom-only
// concern); focuses on rewrapOwnLoginEnvelope's password-rotation
// correctness — the bit a password-change handler depends on.

import { describe, it, expect } from "vitest";
import { rewrapOwnLoginEnvelope } from "../../orgKeys/memberLogin";
import { unwrapPkcs8WithPbkdf2 } from "../../orgKeys/envelopeCodec";
import type { NewLoginWrap } from "../../orgKeys/api";

const enc = new TextEncoder();

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function generateRsaKeypairPkcs8(): Promise<ArrayBuffer> {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  return crypto.subtle.exportKey("pkcs8", kp.privateKey);
}

// Build a wrap directly with WebCrypto so the test doesn't depend on
// `provisionOrgMemberKeypair` (a backend function). Mirrors what the
// backend's encryption::provision_org_member_keypair does for the
// login-wrap side.
async function wrapPkcs8WithPassword(
  pkcs8: ArrayBuffer,
  password: string,
): Promise<NewLoginWrap> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"],
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
    ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    pkcs8,
  );
  return {
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
    salt: bytesToB64(salt),
    iterations: 600_000,
  };
}

describe("memberLogin.rewrapOwnLoginEnvelope", () => {
  it("rotates a wrap from old password to new password — same PKCS8 recoverable from both", async () => {
    const pkcs8 = await generateRsaKeypairPkcs8();
    const oldWrap = await wrapPkcs8WithPassword(pkcs8, "OldPassword123!");
    const newWrap = await rewrapOwnLoginEnvelope(
      "OldPassword123!",
      "NewPassword456!",
      oldWrap,
    );

    // The rotation must preserve the underlying PKCS8 — unwrap the new
    // envelope with the new password and verify byte equality.
    const recovered = await unwrapPkcs8WithPbkdf2(
      newWrap.iv,
      newWrap.ct,
      enc.encode("NewPassword456!"),
      newWrap.salt,
      newWrap.iterations,
    );
    const a = new Uint8Array(pkcs8);
    const b = new Uint8Array(recovered);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
  });

  it("rejects rewrap when the OLD password is wrong (AES-GCM auth tag)", async () => {
    const pkcs8 = await generateRsaKeypairPkcs8();
    const oldWrap = await wrapPkcs8WithPassword(pkcs8, "CorrectOldPassword!");

    await expect(
      rewrapOwnLoginEnvelope("WrongOldPassword!", "NewPassword456!", oldWrap),
    ).rejects.toThrow(/current password|wrong/i);
  });

  it("produces a fresh salt on each rotation (non-deterministic)", async () => {
    const pkcs8 = await generateRsaKeypairPkcs8();
    const oldWrap = await wrapPkcs8WithPassword(pkcs8, "OldPassword123!");

    const a = await rewrapOwnLoginEnvelope("OldPassword123!", "New!", oldWrap);
    const b = await rewrapOwnLoginEnvelope("OldPassword123!", "New!", oldWrap);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("old password CANNOT unwrap the new envelope", async () => {
    const pkcs8 = await generateRsaKeypairPkcs8();
    const oldWrap = await wrapPkcs8WithPassword(pkcs8, "OldPassword123!");
    const newWrap = await rewrapOwnLoginEnvelope(
      "OldPassword123!",
      "BrandNewPassword456!",
      oldWrap,
    );

    await expect(
      unwrapPkcs8WithPbkdf2(
        newWrap.iv,
        newWrap.ct,
        enc.encode("OldPassword123!"),
        newWrap.salt,
        newWrap.iterations,
      ),
    ).rejects.toThrow();
  });
});
