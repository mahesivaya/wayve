// Mnemonic-based recovery of the org master key. Used at two distinct
// moments:
//
//  1. Owner on a fresh device — `/organization/recovery-key` prompts for
//     the 24 words, unwraps the mnemonic envelope, caches the org
//     private key in IndexedDB, optionally re-wraps under the owner's
//     personal pubkey so future sessions on this device auto-load.
//  2. Owner re-bootstrap of personal-pubkey wrap — same logic, just
//     called after they rotate their personal RSA key.
//
// The mnemonic itself never leaves the browser. The unwrap result (the
// org private key) is stored in `wayve_org_keys` IndexedDB only.

import { mnemonicToEntropy } from "../crypto/mnemonic";
import { loadPublicKey } from "../crypto/keyStore";
import { addKeyHolderWrap, getOrgKeys, type MnemonicWrap } from "./api";
import { saveOrgPrivateKey } from "./orgKeyStore";
import { unwrapPkcs8WithPbkdf2, wrapPkcs8ToRsaPubkey } from "./envelopeCodec";

export type UnwrapResult = {
  // Imported as RSA-OAEP-decrypt — usable for unwrapping member escrows.
  privateKey: CryptoKey;
  // Returned to callers who want to immediately re-wrap (e.g. add a key-
  // holder); skip if you only need the private key for one decrypt.
  pkcs8: ArrayBuffer;
};

export async function unwrapOrgKeyWithMnemonic(
  orgId: number,
  callerUserId: number,
  callerEmail: string,
  mnemonic: string,
  wrap: MnemonicWrap,
): Promise<UnwrapResult> {
  const entropy = await mnemonicToEntropy(mnemonic);
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await unwrapPkcs8WithPbkdf2(
      wrap.iv,
      wrap.ct,
      entropy.slice().buffer,
      wrap.pbkdf2_salt,
      wrap.pbkdf2_iterations,
    );
  } catch {
    throw new Error(
      "Could not unwrap the org recovery key — please double-check your 24 words.",
    );
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"],
  );

  // Cache for the session and future sessions on this device.
  await saveOrgPrivateKey(orgId, callerUserId, privateKey);

  // If the caller doesn't already have a user_pubkey wrap (e.g., first
  // recovery on this device), publish one for next time so they don't
  // have to re-enter the mnemonic every session.
  try {
    const current = await getOrgKeys(orgId);
    if (!current.wrapped_user) {
      const founderPub = await loadPublicKey(callerUserId, callerEmail);
      if (founderPub) {
        const userWrap = await wrapPkcs8ToRsaPubkey(pkcs8, founderPub);
        await addKeyHolderWrap(orgId, callerUserId, userWrap);
      }
    }
  } catch {
    // Non-fatal: the user can still use the org key this session even if
    // we couldn't publish a wrap. They'll just be prompted for the
    // mnemonic again next time on this device.
  }

  return { privateKey, pkcs8 };
}

// Same shape as above but with the source being the caller's existing
// user_pubkey wrap rather than the mnemonic. Used at session start by
// owners + admins who already have the org key wrapped under their
// personal pubkey (auto-load path).
export async function unwrapOrgKeyWithUserPubkey(
  orgId: number,
  callerUserId: number,
  callerEmail: string,
): Promise<UnwrapResult | null> {
  const { loadPrivateKey } = await import("../crypto/keyStore");
  const callerPriv = await loadPrivateKey(callerUserId, callerEmail);
  if (!callerPriv) return null;

  const keys = await getOrgKeys(orgId);
  if (!keys.wrapped_user) return null;

  const { unwrapPkcs8WithRsaKey } = await import("./envelopeCodec");
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await unwrapPkcs8WithRsaKey(
      keys.wrapped_user.iv,
      keys.wrapped_user.ct,
      callerPriv,
    );
  } catch {
    return null;
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"],
  );
  await saveOrgPrivateKey(orgId, callerUserId, privateKey);
  return { privateKey, pkcs8 };
}
