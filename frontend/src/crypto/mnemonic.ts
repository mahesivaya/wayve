// 24-word recovery mnemonic. Standard BIP-39: 256 bits of entropy from
// crypto.getRandomValues, plus an 8-bit checksum (the leading bits of
// SHA-256(entropy)), split into 24 eleven-bit indices into the English wordlist.
//
// 256 bits of entropy is far outside any practical brute-force envelope, so the
// PBKDF2 stretching in recovery.ts is defense-in-depth rather than the
// load-bearing layer. Decoding verifies the checksum, so a single-word typo is
// caught locally instead of surfacing as an opaque AES-GCM auth-tag failure.
//
// Envelopes uploaded under the legacy 6-word scheme cannot be unwrapped here;
// those users are re-onboarded on next login.

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
  // Only ever called on the entropy portion of a decoded mnemonic, whose length
  // is divisible by 8.
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
  return bytesToBits(digest).slice(0, CHECKSUM_BITS);
}

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
 * Decode a 24-word mnemonic back to its 32-byte entropy buffer. Throws on a
 * wrong word count, an unknown word, or a checksum mismatch.
 *
 * The checksum catches almost every single-word typo locally, before the AES-GCM
 * step in recovery.ts would have to fail. The rare typo that passes the checksum
 * but yields the wrong key still surfaces cleanly as an auth-tag failure there.
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

/** Lowercase and collapse whitespace so a phrase pasted from anywhere works. */
export function normalizeMnemonicInput(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Live UI feedback. Null means valid; a string is the error to display. */
export async function checkMnemonic(input: string): Promise<string | null> {
  try {
    await mnemonicToEntropy(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid mnemonic";
  }
}

export const MNEMONIC_WORD_COUNT = WORD_COUNT;
