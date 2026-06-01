// Bootstrap-side crypto for the org master key. The owner runs this on
// org-creation to mint a fresh RSA-2048 keypair, generate a BIP-39
// mnemonic, and produce TWO wrapped envelopes — one under the
// PBKDF2(mnemonic) and one under the owner's personal pubkey — for upload
// via /api/organizations/{id}/keys. Everything happens in the owner's
// browser; the plaintext private key never leaves WebCrypto.

import { generateMnemonic, mnemonicToEntropy } from "../crypto/mnemonic";
import { loadPublicKey } from "../crypto/keyStore";
import {
  bootstrapOrgKeys,
  type BootstrapKeysRequest,
  type MnemonicWrap,
  type UserPubkeyWrap,
} from "./api";
import { wrapPkcs8ToRsaPubkey } from "./envelopeCodec";

const PBKDF2_ITERATIONS = 600_000; // matches frontend/src/crypto/recovery.ts

export type BootstrapResult = {
  // Space-separated 24-word string — same shape generateMnemonic() returns.
  // Callers split on /\s+/ for word-by-word display.
  mnemonic: string;
  publicKeyBytes: ArrayBuffer;
};

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Wait up to ~5s for the personal pubkey to land in IndexedDB. AuthContext's
// `setupEncryption` runs in the background after login, so the very first
// org-bootstrap redirect after a brand-new owner logs in can fire BEFORE
// the personal keypair has been saved. Polling here keeps the bootstrap
// page from failing with a confusing "sign in fully first" message just
// because the two async tasks raced.
async function waitForPublicKey(
  userId: number,
  email: string,
  timeoutMs = 5000,
  intervalMs = 200,
): Promise<ArrayBuffer | null> {
  const start = performance.now();
  // First attempt is immediate so steady-state (key already present)
  // doesn't pay the polling tax.
  let key = await loadPublicKey(userId, email);
  while (!key && performance.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    key = await loadPublicKey(userId, email);
  }
  return key;
}

async function deriveMnemonicKey(
  mnemonicEntropy: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    mnemonicEntropy.slice().buffer,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.slice().buffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function bootstrapOrgMasterKey(
  orgId: number,
  founderUserId: number,
  founderEmail: string,
): Promise<BootstrapResult> {
  // 1. Generate org RSA-2048 keypair.
  const orgPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["wrapKey", "unwrapKey", "encrypt", "decrypt"],
  );

  // 2. Export private (PKCS8) for wrapping, public (SPKI) for upload.
  const orgPrivatePkcs8 = await crypto.subtle.exportKey("pkcs8", orgPair.privateKey);
  const orgPublicSpki = await crypto.subtle.exportKey("spki", orgPair.publicKey);

  // 3. Generate the 24-word mnemonic.
  const mnemonic = await generateMnemonic();
  const entropy = await mnemonicToEntropy(mnemonic);

  // 4. Mnemonic wrap: per-org random salt + PBKDF2 + AES-GCM.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveMnemonicKey(entropy, salt);
  const mnemonicCt = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    orgPrivatePkcs8,
  );
  const wrapped_mnemonic: MnemonicWrap = {
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(mnemonicCt)),
    pbkdf2_salt: bytesToB64(salt),
    pbkdf2_iterations: PBKDF2_ITERATIONS,
  };

  // 5. User-pubkey wrap: encrypt the same PKCS8 to the founder's
  //    PERSONAL pubkey so they auto-load the org key on this device
  //    without re-entering the mnemonic next session.
  //
  //    AuthContext's `setupEncryption` generates the personal keypair
  //    asynchronously and is NOT awaited before `user` is set — so
  //    BootstrapPage can mount and call into here before the pubkey
  //    has landed in IndexedDB. Poll for up to ~5s so the redirect
  //    path from OrganizationAdminHome doesn't race against personal-
  //    keypair generation.
  const founderPub = await waitForPublicKey(founderUserId, founderEmail);
  if (!founderPub) {
    throw new Error(
      "Founder personal public key not found on this device — sign in fully first.",
    );
  }
  const wrapped_user: UserPubkeyWrap = await wrapPkcs8ToRsaPubkey(
    orgPrivatePkcs8,
    founderPub,
  );

  // 6. POST everything to the backend.
  const body: BootstrapKeysRequest = {
    public_key: JSON.stringify(Array.from(new Uint8Array(orgPublicSpki))),
    wrapped_mnemonic,
    wrapped_user,
  };
  await bootstrapOrgKeys(orgId, body);

  return { mnemonic, publicKeyBytes: orgPublicSpki };
}
