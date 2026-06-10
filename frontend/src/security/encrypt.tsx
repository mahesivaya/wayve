type EncryptedPayload = {
  iv: number[];
  data: number[];
};

export async function encrypt(text: string, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext)),
  };
}

export async function generateKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function decrypt(encrypted: EncryptedPayload, key: CryptoKey) {
  const iv = new Uint8Array(encrypted.iv);
  const data = new Uint8Array(encrypted.data);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );

  return new TextDecoder().decode(decrypted);
}
