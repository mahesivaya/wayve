// Mnemonic-based recovery of the org master key, used both when an owner arrives
// on a fresh device and when they re-bootstrap the personal-pubkey wrap after
// rotating their personal RSA key.
//
// The mnemonic never leaves the browser, and the unwrapped org private key is
// stored only in IndexedDB.

import { mnemonicToEntropy } from "../crypto/mnemonic";
import { loadPublicKey } from "../crypto/keyStore";
import { addKeyHolderWrap, getOrgKeys, type MnemonicWrap } from "./api";
import { saveOrgPrivateKey } from "./orgKeyStore";
import { unwrapPkcs8WithPbkdf2, wrapPkcs8ToRsaPubkey } from "./envelopeCodec";

export type UnwrapResult = {
  // Decrypt-only, and therefore able to unwrap member escrows.
  privateKey: CryptoKey;
  // Only needed by callers that immediately re-wrap, such as adding a key holder.
  pkcs8: ArrayBuffer;
};

export async function unwrapOrgKeyWithMnemonic(
  orgId: number,
  callerUserId: number,
  callerEmail: string,
  mnemonic: string,
  wrap: MnemonicWrap
): Promise<UnwrapResult> {
  const entropy = await mnemonicToEntropy(mnemonic);
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await unwrapPkcs8WithPbkdf2(
      wrap.iv,
      wrap.ct,
      entropy.slice().buffer,
      wrap.pbkdf2_salt,
      wrap.pbkdf2_iterations
    );
  } catch {
    throw new Error(
      "Could not unwrap the org recovery key — please double-check your 24 words."
    );
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );

  await saveOrgPrivateKey(orgId, callerUserId, privateKey);

  // Publish a user_pubkey wrap if the caller has none, so they aren't asked for
  // the mnemonic again on every session.
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
    // Non-fatal: the org key still works this session. The user is simply asked
    // for the mnemonic again next time on this device.
  }

  return { privateKey, pkcs8 };
}

// The auto-load path: same result as above, but sourced from the caller's
// existing user_pubkey wrap instead of the mnemonic.
export async function unwrapOrgKeyWithUserPubkey(
  orgId: number,
  callerUserId: number,
  callerEmail: string
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
      callerPriv
    );
  } catch {
    return null;
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
  await saveOrgPrivateKey(orgId, callerUserId, privateKey);
  return { privateKey, pkcs8 };
}
