// Generates FluxzeTests/CryptoVectors.swift: a key, its login wrap, its
// recovery-phrase copy and sealed envelopes, all made with WebCrypto exactly as
// the web app (frontend/src/crypto, frontend/src/orgKeys) and the server
// (wayve-security encrypt_to_pubkey) make them. The iPhone tests must open every
// one, which keeps the two implementations in step.
//
//   node ios/FluxzeTests/Fixtures/make-crypto-vectors.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { subtle } = globalThis.crypto;
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");

const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString("base64");
const arr = (buf) => Array.from(new Uint8Array(buf));
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function pbkdf2Key(secret, salt, iterations) {
  const base = await subtle.importKey("raw", secret, { name: "PBKDF2" }, false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

// The key pair, as the browser generates it.
const pair = await subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"]
);
const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
const spki = await subtle.exportKey("spki", pair.publicKey);

// Login wrap (orgKeys/memberLogin.ts). Fewer rounds than production's 600k to
// keep the test quick; the count travels in the envelope.
const password = "correct horse battery staple ✓";
const loginSalt = rand(16);
const loginIv = rand(12);
const loginIterations = 2000;
const loginCt = await subtle.encrypt(
  { name: "AES-GCM", iv: loginIv },
  await pbkdf2Key(new TextEncoder().encode(password), loginSalt, loginIterations),
  pkcs8
);

// Recovery phrase (crypto/mnemonic.ts + crypto/recovery.ts).
const words = [...readFileSync(join(repo, "frontend/src/crypto/wordlist.ts"), "utf8").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
const entropy = rand(32);
const checksum = new Uint8Array(await subtle.digest("SHA-256", entropy))[0];
const bits = [...entropy].map((b) => b.toString(2).padStart(8, "0")).join("") + checksum.toString(2).padStart(8, "0");
const phrase = Array.from({ length: 24 }, (_, i) => words[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]).join(" ");
const recoveryIv = rand(12);
const recoveryCt = await subtle.encrypt(
  { name: "AES-GCM", iv: recoveryIv },
  await pbkdf2Key(entropy, new TextEncoder().encode("wayve-recovery-v1"), 600000),
  pkcs8
);

// Envelopes: a fresh AES key, RSA-OAEP-wrapped for the recipient.
async function seal(text) {
  const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = rand(12);
  const data = await subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(text));
  const key = await subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, await subtle.exportKey("raw", aes));
  return { data: arr(data), iv: arr(iv), key: arr(key) };
}
const userId = 42;
const single = await seal("<p>Hello from the server ✓</p>");
const multi = await seal("Fluxze to Fluxze");
const note = await seal("A private note");
const envelope = (o) => "WAYVE_SECURE_V1\n" + JSON.stringify(o);

// A Drive file in the WV1 binary envelope (crypto/fileEnvelope.ts).
const fileBody = new TextEncoder().encode("%PDF-1.4 drive file ✓");
const fileAes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const fileIv = rand(12);
const fileCt = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: fileIv }, fileAes, fileBody));
const fileWrapped = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, await subtle.exportKey("raw", fileAes)));
const wlen = new Uint8Array([(fileWrapped.length >>> 24) & 255, (fileWrapped.length >>> 16) & 255, (fileWrapped.length >>> 8) & 255, fileWrapped.length & 255]);
const fileEnvelope = new Uint8Array([0x57, 0x56, 0x31, 0x00, 0, 1, ...fileIv, ...wlen, ...fileWrapped, ...fileCt]);

// A chat message in the WAYVE_CHAT_E2E_V1 envelope (frontend/src/chat/e2ee.ts).
const chatAes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const chatIv = rand(12);
const chatData = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: chatIv }, chatAes, new TextEncoder().encode("Hi from the web ✓")));
const chatWrapped = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, await subtle.exportKey("raw", chatAes)));
const chat = "WAYVE_CHAT_E2E_V1\n" + JSON.stringify({ type: "wayve_chat_e2e", data: Array.from(chatData), iv: Array.from(chatIv), keys: { [userId]: Array.from(chatWrapped) } });

const v = {
  pkcs8: b64(pkcs8),
  spki: b64(spki),
  password,
  loginWrap: { iv: b64(loginIv), ct: b64(loginCt), salt: b64(loginSalt), iterations: loginIterations },
  phrase,
  entropy: b64(entropy),
  recovery: { v: 1, iv: b64(recoveryIv), pub: b64(spki), ct: b64(recoveryCt) },
  userId,
  single: envelope({ type: "wayve_encrypted", data: single.data, key: single.key, iv: single.iv }),
  multi: envelope({ type: "wayve_encrypted_multi", data: multi.data, iv: multi.iv, keys: { [userId]: multi.key } }),
  file: b64(fileEnvelope),
  fileText: "%PDF-1.4 drive file ✓",
  chat,
  chatText: "Hi from the web ✓",
  note: envelope({ type: "wayve_self_v1", data: note.data, iv: note.iv, keys: { [userId]: note.key } }),
};

const swift = `// Generated by Fixtures/make-crypto-vectors.mjs with WebCrypto, as the web app
// and server seal data. Regenerate rather than edit.
enum CryptoVectors {
    static let json = #"""
${JSON.stringify(v, null, 2)}
"""#
}
`;
writeFileSync(join(here, "../CryptoVectors.swift"), swift);
console.log("wrote CryptoVectors.swift");
