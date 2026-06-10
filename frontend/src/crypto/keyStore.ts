const DB_NAME = "wayve_keys";
const STORE_NAME = "keys";
const DB_VERSION = 1;
const LEGACY_PRIVATE_KEY_ID = "privateKey";
const LEGACY_PUBLIC_KEY_ID = "publicKey";

function privateKeyId(userId?: number | null) {
  return userId ? `privateKey:${userId}` : LEGACY_PRIVATE_KEY_ID;
}

function publicKeyId(userId?: number | null) {
  return userId ? `publicKey:${userId}` : LEGACY_PUBLIC_KEY_ID;
}

// Email-keyed aliases. Used as a fallback when the user's `userId` has
// shifted out from under us — e.g., the local Postgres got reset in
// development and the same email got a new `users.id`, or a future
// account-merge moves an email to a different id. Without this fallback,
// the userId-keyed entry from the previous session is orphaned and
// setupEncryption thinks it's a brand-new device, which re-shows the
// "Save your recovery phrase" modal on every login.
function privateKeyEmailId(email?: string | null) {
  return email ? `privateKey:email:${email.toLowerCase()}` : null;
}

function publicKeyEmailId(email?: string | null) {
  return email ? `publicKey:email:${email.toLowerCase()}` : null;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putAll(db: IDBDatabase, entries: Array<[string, unknown]>) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const [key, value] of entries) {
      store.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getOne(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 🔐 Save private key under both the userId-keyed slot and (if provided) an
// email-keyed alias so we can recover from userId churn.
export async function savePrivateKey(
  key: CryptoKey,
  userId?: number | null,
  email?: string | null
) {
  const db = await openDB();
  const exported = await crypto.subtle.exportKey("pkcs8", key);

  const entries: Array<[string, unknown]> = [[privateKeyId(userId), exported]];
  const emailKey = privateKeyEmailId(email);
  if (emailKey) entries.push([emailKey, exported]);

  return putAll(db, entries);
}

// 🔐 Save public key bytes (same dual-keying rationale as savePrivateKey).
export async function savePublicKey(
  publicKey: ArrayBuffer,
  userId?: number | null,
  email?: string | null
) {
  const db = await openDB();
  const publicKeyBytes = new Uint8Array(publicKey).slice().buffer;

  const entries: Array<[string, unknown]> = [
    [publicKeyId(userId), publicKeyBytes],
  ];
  const emailKey = publicKeyEmailId(email);
  if (emailKey) entries.push([emailKey, publicKeyBytes]);

  return putAll(db, entries);
}

async function importPrivateKey(pkcs8: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
}

// 🔓 Load private key. Tries userId first; falls back to the email alias
// if provided. On an email-alias hit, also writes the bytes back under
// the current userId so subsequent userId-only lookups (from chat / emails
// / file decrypt paths) succeed without needing to pass email everywhere.
export async function loadPrivateKey(
  userId?: number | null,
  email?: string | null
): Promise<CryptoKey | null> {
  const db = await openDB();
  const primaryKey = privateKeyId(userId);

  const direct = await getOne(db, primaryKey);
  if (direct) {
    return importPrivateKey(direct as ArrayBuffer);
  }

  const emailKey = privateKeyEmailId(email);
  if (!emailKey) return null;

  const fallback = await getOne(db, emailKey);
  if (!fallback) return null;

  // Re-key under the current userId so future lookups don't pay the
  // fallback cost. Fire-and-forget; correctness doesn't depend on it
  // landing before the next lookup.
  putAll(db, [[primaryKey, fallback]]).catch(() => {});
  return importPrivateKey(fallback as ArrayBuffer);
}

// 🔓 Load saved public key bytes. Same userId-then-email fallback as
// loadPrivateKey.
export async function loadPublicKey(
  userId?: number | null,
  email?: string | null
): Promise<ArrayBuffer | null> {
  const db = await openDB();
  const primaryKey = publicKeyId(userId);

  const direct = await getOne(db, primaryKey);
  if (direct) {
    return direct instanceof ArrayBuffer
      ? direct
      : new Uint8Array(direct as ArrayBufferLike).slice().buffer;
  }

  const emailKey = publicKeyEmailId(email);
  if (!emailKey) return null;

  const fallback = await getOne(db, emailKey);
  if (!fallback) return null;

  const buffer =
    fallback instanceof ArrayBuffer
      ? fallback
      : new Uint8Array(fallback as ArrayBufferLike).slice().buffer;

  putAll(db, [[primaryKey, buffer]]).catch(() => {});
  return buffer;
}
