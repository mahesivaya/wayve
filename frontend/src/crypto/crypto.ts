function toArrayBuffer(
  input: ArrayBuffer | SharedArrayBuffer | Uint8Array
): ArrayBuffer {
  if (input instanceof Uint8Array) {
    return input.slice().buffer;
  }
  if (input instanceof ArrayBuffer) {
    return input;
  }
  const view = new Uint8Array(input);
  return view.slice().buffer;
}

export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(text: string, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoded)
  );

  return {
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };
}

export async function decrypt(
  encrypted: { iv: string; data: string },
  key: CryptoKey
) {
  const iv = Uint8Array.from(atob(encrypted.iv), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(encrypted.data), (c) => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(data)
  );

  return new TextDecoder().decode(decrypted);
}

export async function encryptMessage(message: string, publicKey: CryptoKey) {
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encryptedMessage = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    aesKey,
    new TextEncoder().encode(message)
  );

  const rawKey = await crypto.subtle.exportKey("raw", aesKey);

  // Wrap the AES key to the receiver, who alone can unwrap it.
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawKey
  );

  return {
    encryptedMessage,
    encryptedKey,
    iv,
  };
}

/**
 * Encrypts a File or Blob for Drive and attachments into the shared envelope
 * format, so one decoder covers every feature.
 */
export async function encryptFile(file: File | Blob, publicKey: CryptoKey) {
  const arrayBuffer = await file.arrayBuffer();

  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encryptedData = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    aesKey,
    arrayBuffer
  );

  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const encryptedAesKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawAesKey
  );

  return (
    "WAYVE_SECURE_V1\n" +
    JSON.stringify({
      type: "wayve_encrypted_file",
      name: (file as File).name || "encrypted_file",
      mimeType: file.type,
      data: Array.from(new Uint8Array(encryptedData)),
      key: Array.from(new Uint8Array(encryptedAesKey)),
      iv: Array.from(iv),
    })
  );
}

export async function decryptMessage(
  encryptedMessage: ArrayBuffer | SharedArrayBuffer | Uint8Array,
  encryptedKey: ArrayBuffer | SharedArrayBuffer | Uint8Array,
  iv: Uint8Array,
  privateKey: CryptoKey
): Promise<string> {
  const msg = toArrayBuffer(encryptedMessage);
  const key = toArrayBuffer(encryptedKey);

  const rawKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    key
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    aesKey,
    msg
  );

  return new TextDecoder().decode(decrypted);
}
