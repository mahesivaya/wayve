// 24-word recovery mnemonic. Standard BIP-39:
//   - 256 bits of entropy from crypto.getRandomValues
//   - 8-bit checksum = first 8 bits of SHA-256(entropy)
//   - 264 bits = 24 × 11 bits → 24 words from the BIP-39 English wordlist
//
// Strength: 256 bits of entropy is well outside any practical brute-force
// envelope, so the PBKDF2 stretching in recovery.ts is a defense-in-depth
// layer rather than the load-bearing one. Decoding verifies the SHA-256
// checksum, so a single-word typo is caught locally instead of falling
// through to an opaque AES-GCM auth-tag failure.
//
// This file replaces the legacy 6-word custom encoding. Legacy envelopes
// uploaded under the 6-word scheme cannot be unwrapped here — the
// dev-DB cleanup step removes any stragglers; in production we just
// re-onboard those users on next login.

import { BIP39_ENGLISH } from "./wordlist";

const WORD_COUNT = 24;
const ENTROPY_BITS = 256;
const CHECKSUM_BITS = ENTROPY_BITS / 32; // = 8
const ENTROPY_BYTES = ENTROPY_BITS / 8; // = 32

const WORD_INDEX = new Map<string, number>(
  BIP39_ENGLISH.map((word, index) => [word, index])
);

function bytesToBits(bytes: Uint8Array): string {
  let bits = "";
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, "0");
  }
  return bits;
}

function bitsToBytes(bits: string): Uint8Array {
  // Caller must pass a multiple-of-8 string. Used only on the entropy
  // portion of a decoded mnemonic (ENTROPY_BITS, which is divisible by 8).
  if (bits.length % 8 !== 0) {
    throw new Error("bitsToBytes: bit-string length must be a multiple of 8");
  }
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(bits.slice(i * 8, (i + 1) * 8), 2);
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return new Uint8Array(digest);
}

async function checksumBits(entropy: Uint8Array): Promise<string> {
  const digest = await sha256(entropy);
  // Take the first CHECKSUM_BITS bits of the SHA-256 hash.
  return bytesToBits(digest).slice(0, CHECKSUM_BITS);
}

/**
 * Generate a fresh 24-word recovery mnemonic with a valid BIP-39 checksum.
 */
export async function generateMnemonic(): Promise<string> {
  const entropy = new Uint8Array(ENTROPY_BYTES);
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy);
}

async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new Error(`Entropy must be ${ENTROPY_BYTES} bytes`);
  }
  const bits = bytesToBits(entropy) + (await checksumBits(entropy));
  const words: string[] = [];
  for (let i = 0; i < WORD_COUNT; i++) {
    const idx = parseInt(bits.slice(i * 11, (i + 1) * 11), 2);
    words.push(BIP39_ENGLISH[idx]);
  }
  return words.join(" ");
}

/**
 * Decode a 24-word mnemonic back to its 32-byte entropy buffer. Throws on:
 *   - Wrong word count
 *   - Unknown word (typo, wrong language)
 *   - Invalid SHA-256 checksum (typo that lands on a valid word)
 *
 * The checksum catches almost all single-word typos locally before the
 * AES-GCM step in recovery.ts has to fail. The few typos that pass the
 * checksum but produce the wrong key still surface as a clean
 * "could not decrypt recovery payload" via AES-GCM auth-tag verification.
 */
export async function mnemonicToEntropy(mnemonic: string): Promise<Uint8Array> {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (words.length !== WORD_COUNT) {
    throw new Error(`Expected ${WORD_COUNT} words, got ${words.length}`);
  }

  let bits = "";
  for (const word of words) {
    const idx = WORD_INDEX.get(word);
    if (idx === undefined) {
      throw new Error(`Unknown word: "${word}"`);
    }
    bits += idx.toString(2).padStart(11, "0");
  }

  const entropyBits = bits.slice(0, ENTROPY_BITS);
  const claimedChecksum = bits.slice(ENTROPY_BITS);
  const entropy = bitsToBytes(entropyBits);
  const computedChecksum = await checksumBits(entropy);
  if (computedChecksum !== claimedChecksum) {
    throw new Error("Invalid recovery phrase (checksum mismatch)");
  }
  return entropy;
}

/** Lowercase + collapse repeated whitespace for paste-from-anywhere UX. */
export function normalizeMnemonicInput(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Live-UI feedback ("All 24 words look good ✓"). Null = OK, string = error. */
export async function checkMnemonic(input: string): Promise<string | null> {
  try {
    await mnemonicToEntropy(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid mnemonic";
  }
}

/** Number of words the rest of the UI should expect. */
export const MNEMONIC_WORD_COUNT = WORD_COUNT;
