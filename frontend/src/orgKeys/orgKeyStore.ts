// IndexedDB cache for the org master PRIVATE key — parallel to
// `crypto/keyStore.ts` (which caches the user's personal RSA key) but in
// its own object store so a wipe of one doesn't take the other with it.
//
// The org private key is short-lived in memory only when needed (decrypt
// a member's escrow for recovery, reset, or audit). Cached here so the
// key-holder doesn't have to re-enter their mnemonic each session — they
// only re-enter it on a brand-new device.

const DB_NAME = "wayve_org_keys";
const STORE_NAME = "keys";
const DB_VERSION = 1;

function orgPrivateKeyId(orgId: number, userId: number): string {
  return `orgPrivate:${orgId}:${userId}`;
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

function put(db: IDBDatabase, key: string, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getOne(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function del(db: IDBDatabase, key: string) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveOrgPrivateKey(
  orgId: number,
  userId: number,
  privateKey: CryptoKey
): Promise<void> {
  const db = await openDB();
  const exported = await crypto.subtle.exportKey("pkcs8", privateKey);
  return put(db, orgPrivateKeyId(orgId, userId), exported);
}

export async function loadOrgPrivateKey(
  orgId: number,
  userId: number
): Promise<CryptoKey | null> {
  const db = await openDB();
  const direct = await getOne(db, orgPrivateKeyId(orgId, userId));
  if (!direct) return null;
  return crypto.subtle.importKey(
    "pkcs8",
    direct as ArrayBuffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
}

export async function clearOrgPrivateKey(
  orgId: number,
  userId: number
): Promise<void> {
  const db = await openDB();
  return del(db, orgPrivateKeyId(orgId, userId));
}
