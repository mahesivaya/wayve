// Bootstrap-side crypto for the org master key. At org creation the owner mints
// an RSA-2048 keypair and a BIP-39 mnemonic, then produces two wrapped
// envelopes: one under PBKDF2(mnemonic) and one under the owner's personal
// public key. Everything happens in the owner's browser and the plaintext
// private key never leaves WebCrypto.

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
  // Space-separated 24-word string; callers split on /\s+/ to display it.
  mnemonic: string;
  publicKeyBytes: ArrayBuffer;
};

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// AuthContext's `setupEncryption` runs in the background after login, so the
// first org-bootstrap redirect for a brand-new owner can fire before the
// personal keypair has been saved. That setup can take several seconds on cold
// WebCrypto and a slow network, so poll instead of failing the bootstrap page
// with a confusing "sign in fully first" purely because the two tasks raced.
export async function waitForPublicKey(
  userId: number,
  email: string,
  timeoutMs = 20_000,
  intervalMs = 250
): Promise<ArrayBuffer | null> {
  const start = performance.now();
  // Try once immediately so the steady state, where the key is already present,
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
  salt: Uint8Array
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    mnemonicEntropy.slice().buffer,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
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
    ["encrypt", "decrypt"]
  );
}

export async function bootstrapOrgMasterKey(
  orgId: number,
  founderUserId: number,
  founderEmail: string
): Promise<BootstrapResult> {
  const orgPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["wrapKey", "unwrapKey", "encrypt", "decrypt"]
  );

  // PKCS8 for wrapping, SPKI for upload.
  const orgPrivatePkcs8 = await crypto.subtle.exportKey(
    "pkcs8",
    orgPair.privateKey
  );
  const orgPublicSpki = await crypto.subtle.exportKey(
    "spki",
    orgPair.publicKey
  );

  const mnemonic = await generateMnemonic();
  const entropy = await mnemonicToEntropy(mnemonic);

  // Mnemonic wrap: per-org random salt, PBKDF2, AES-GCM.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveMnemonicKey(entropy, salt);
  const mnemonicCt = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    orgPrivatePkcs8
  );
  const wrapped_mnemonic: MnemonicWrap = {
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(mnemonicCt)),
    pbkdf2_salt: bytesToB64(salt),
    pbkdf2_iterations: PBKDF2_ITERATIONS,
  };

  // User-pubkey wrap: encrypt the same PKCS8 to the founder's personal public
  // key, so next session they auto-load the org key on this device without
  // re-entering the mnemonic. The personal key should already be in IndexedDB by
  // now, but setupEncryption is not awaited before `user` flips, so poll briefly
  // as a safety net against that race.
  const founderPub = await waitForPublicKey(founderUserId, founderEmail);
  if (!founderPub) {
    throw new Error(
      "Founder personal public key not found on this device — sign in fully first."
    );
  }
  const wrapped_user: UserPubkeyWrap = await wrapPkcs8ToRsaPubkey(
    orgPrivatePkcs8,
    founderPub
  );

  const body: BootstrapKeysRequest = {
    public_key: JSON.stringify(Array.from(new Uint8Array(orgPublicSpki))),
    wrapped_mnemonic,
    wrapped_user,
  };
  await bootstrapOrgKeys(orgId, body);

  return { mnemonic, publicKeyBytes: orgPublicSpki };
}
