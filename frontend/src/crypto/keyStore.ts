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

// Email-keyed aliases, used as a fallback when the user's `userId` shifts out
// from under us: a dev Postgres reset that hands the same email a new
// `users.id`, or an account merge. Without them the userId-keyed entry is
// orphaned, setupEncryption concludes this is a brand-new device, and the
// "Save your recovery phrase" modal reappears on every login.
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

// Mark this origin's storage persistent so the cached keypair is not
// auto-evicted by Safari's roughly weekly cycle, Chrome under storage pressure,
// or a "clear on close" mode. An evicted keystore forces the 24-word recovery
// prompt on the next hard refresh. Idempotent, never throws, and must never
// block encryption setup.
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// Wipe every cached key from IndexedDB, across all userId and email slots.
// Called on EXPLICIT logout, so the private key doesn't linger on a shared
// device, and deliberately NOT on session expiry, which keeps the key so
// re-login stays smooth. A wipe error must not block logout.
export async function clearKeys(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort.
  }
}

// Saved under both the userId slot and, when available, the email alias, so a
// userId change doesn't orphan the key.
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

// Dual-keyed for the same reason as savePrivateKey.
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

// Tries the userId slot first, then the email alias. An alias hit is written
// back under the current userId, so later userId-only lookups from the chat,
// email and file decrypt paths succeed without threading email through them.
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

  // Re-key under the current userId so future lookups skip the fallback.
  // Fire-and-forget: correctness doesn't depend on it landing first.
  putAll(db, [[primaryKey, fallback]]).catch(() => {});
  return importPrivateKey(fallback as ArrayBuffer);
}

// Same userId-then-email fallback as loadPrivateKey.
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
