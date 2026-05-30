use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose;
use hkdf::Hkdf;
use rand::{RngCore, thread_rng};
use rsa::{
    Oaep, RsaPublicKey,
    pkcs8::DecodePublicKey,
};
use sha2::{Sha256, Sha512};

const HKDF_INFO: &[u8] = b"rwayve:v1:aes-256-gcm:messages-email-bodies";
const DEFAULT_HKDF_SALT: &[u8] = b"rwayve:v1:hkdf-sha512";

/// Wire prefix for the single-recipient RSA-OAEP + AES-GCM envelope used
/// for "encrypt-on-arrival" inbound mail. Matches the format the frontend
/// decoder in `frontend/src/emails/bodyUtils.ts` (`WAYVE_SECURE_PREFIX`)
/// expects: prefix line, then a JSON object with type `wayve_encrypted`
/// and byte-array fields `data` (AES-GCM ciphertext), `key` (RSA-OAEP
/// wrapped AES key), `iv` (12-byte AES-GCM nonce).
const WAYVE_SECURE_PREFIX: &str = "WAYVE_SECURE_V1";

pub fn encrypt(text: &str) -> Result<(String, String)> {
    let (nonce, ciphertext) = encrypt_binary(text.as_bytes())?;
    Ok((nonce, general_purpose::STANDARD.encode(ciphertext)))
}

pub fn encrypt_binary(bytes: &[u8]) -> Result<(String, Vec<u8>)> {
    let key_bytes = get_key().map_err(anyhow::Error::msg)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let mut nonce_bytes = [0u8; 12];
    thread_rng().fill_bytes(&mut nonce_bytes);

    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, bytes)
        .map_err(|e| anyhow::anyhow!("encryption failed: {:?}", e))?;

    Ok((general_purpose::STANDARD.encode(nonce_bytes), ciphertext))
}

pub fn decrypt_binary(nonce_b64: &str, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let key_bytes = get_key()?;
    let nonce = general_purpose::STANDARD
        .decode(nonce_b64)
        .map_err(|e| format!("Nonce decode error: {:?}", e))?;

    if nonce.len() != 12 {
        return Err(format!(
            "Invalid nonce length: expected 12, got {}",
            nonce.len()
        ));
    }

    if ciphertext.is_empty() {
        return Err("Empty ciphertext".to_string());
    }

    decrypt_with_legacy_fallback(&key_bytes, &nonce, ciphertext)
}

pub fn decrypt(nonce_b64: &str, cipher_b64: &str) -> Result<String, String> {
    let key_bytes = get_key()?;

    // decode nonce
    let nonce = general_purpose::STANDARD
        .decode(nonce_b64)
        .map_err(|e| format!("Nonce decode error: {:?}", e))?;

    // AES-GCM nonce is fixed 12 bytes; passing anything else makes
    // `Nonce::from_slice` panic in generic-array. Reject explicitly so
    // callers get a clean error instead of a panic.
    if nonce.len() != 12 {
        return Err(format!(
            "Invalid nonce length: expected 12, got {}",
            nonce.len()
        ));
    }

    // decode ciphertext
    let ciphertext = general_purpose::STANDARD
        .decode(cipher_b64)
        .map_err(|e| format!("Cipher decode error: {:?}", e))?;

    if ciphertext.is_empty() {
        return Err("Empty ciphertext".to_string());
    }

    let decrypted = decrypt_with_legacy_fallback(&key_bytes, &nonce, &ciphertext)?;

    // utf8 conversion
    let text = String::from_utf8(decrypted).map_err(|e| format!("UTF8 error: {:?}", e))?;

    Ok(text)
}

fn decrypt_with_legacy_fallback(
    key_bytes: &[u8; 32],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    decrypt_bytes(key_bytes, nonce, ciphertext).or_else(|hkdf_error| {
        let legacy_key = get_key_material()?;

        if legacy_key == *key_bytes {
            return Err(hkdf_error);
        }

        decrypt_bytes(&legacy_key, nonce, ciphertext).map_err(|_| hkdf_error)
    })
}

fn get_key() -> Result<[u8; 32], String> {
    let key_material = get_key_material()?;
    derive_hkdf_sha512_key(&key_material)
}

fn get_key_material() -> Result<[u8; 32], String> {
    let key = crate::config::aes_key()
        .ok_or_else(|| "AES_KEY is not set. Configure a 64-character Hex64 key.".to_string())?;
    let trimmed = key.trim();

    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return decode_hex64(trimmed);
    }

    trimmed
        .as_bytes()
        .try_into()
        .map_err(|_| "AES_KEY must be Hex64 (64 hex chars for 32 bytes)".to_string())
}

fn derive_hkdf_sha512_key(input_key_material: &[u8; 32]) -> Result<[u8; 32], String> {
    let salt = hkdf_salt();
    let hk = Hkdf::<Sha512>::new(Some(&salt), input_key_material);
    let mut output_key_material = [0u8; 32];

    hk.expand(HKDF_INFO, &mut output_key_material)
        .map_err(|_| "HKDF-SHA512 key derivation failed".to_string())?;

    Ok(output_key_material)
}

fn hkdf_salt() -> Vec<u8> {
    match crate::config::aes_hkdf_salt() {
        Some(value) => value.into_bytes(),
        None => DEFAULT_HKDF_SALT.to_vec(),
    }
}

fn decrypt_bytes(key_bytes: &[u8; 32], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let key = Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);

    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext.as_ref())
        .map_err(|e| format!("Decrypt error: {:?}", e))
}

fn decode_hex64(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 {
        return Err("AES_KEY Hex64 must be exactly 64 hex characters".to_string());
    }

    let mut bytes = [0u8; 32];

    for (idx, chunk) in hex.as_bytes().chunks_exact(2).enumerate() {
        let hi = hex_value(chunk[0])?;
        let lo = hex_value(chunk[1])?;
        bytes[idx] = (hi << 4) | lo;
    }

    Ok(bytes)
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("AES_KEY Hex64 contains a non-hex character".to_string()),
    }
}

// ──────────────────────────────────────────────────────────────────────
// Plan A — inbound "encrypt-on-arrival"
// ──────────────────────────────────────────────────────────────────────
//
// `encrypt_to_pubkey` wraps a freshly-fetched inbound email body into a
// `WAYVE_SECURE_V1` envelope that only the owner's private key can open.
// The body-worker calls this once per fetched message, then writes the
// resulting string into `emails.body_encrypted`. The server holds no
// material that can decrypt it after the call returns — plaintext only
// existed in memory for the duration of the encrypt call.
//
// Wire shape (must match `frontend/src/emails/bodyUtils.ts` decoder):
//
//   WAYVE_SECURE_V1
//   { "type": "wayve_encrypted",
//     "data": [ ...AES-GCM ciphertext bytes... ],
//     "key":  [ ...RSA-OAEP-SHA256 wrapped 32-byte AES key... ],
//     "iv":   [ ...12 AES-GCM nonce bytes... ] }

/// Build a `WAYVE_SECURE_V1` single-recipient envelope around `plaintext`.
/// `spki_der` is the recipient's RSA public key in SPKI DER form — the
/// raw bytes Browser WebCrypto produces from `exportKey("spki", …)`,
/// which is exactly what `users.public_key` stores (as a JSON array of
/// bytes). Returns the full envelope string ready to persist verbatim.
pub fn encrypt_to_pubkey(plaintext: &[u8], spki_der: &[u8]) -> Result<String> {
    // 1. Import the recipient's RSA public key. `from_public_key_der`
    //    accepts SPKI bytes (the SubjectPublicKeyInfo wrapper Browser
    //    WebCrypto produces) — pkcs1 would also work for raw RSA, but
    //    SPKI is what the frontend sends us.
    let public_key = RsaPublicKey::from_public_key_der(spki_der)
        .map_err(|e| anyhow::anyhow!("public key parse failed: {e}"))?;

    // 2. Generate a fresh AES-256 key for this single record. Never reuse;
    //    each email gets its own DEK, which limits blast radius if any
    //    one wrapped key is ever recovered.
    let mut aes_key_bytes = [0u8; 32];
    let mut nonce_bytes = [0u8; 12];
    thread_rng().fill_bytes(&mut aes_key_bytes);
    thread_rng().fill_bytes(&mut nonce_bytes);

    // 3. AES-GCM encrypt the body.
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key_bytes));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow::anyhow!("AES-GCM encrypt failed: {e:?}"))?;

    // 4. RSA-OAEP-SHA256 wrap the AES key. SHA-256 matches the hash the
    //    frontend uses when it imports the keypair (see selfEncrypt.ts /
    //    keyStore.ts — `{ name: "RSA-OAEP", hash: "SHA-256" }`).
    let padding = Oaep::new::<Sha256>();
    let wrapped_key = public_key
        .encrypt(&mut thread_rng(), padding, &aes_key_bytes)
        .map_err(|e| anyhow::anyhow!("RSA-OAEP wrap failed: {e}"))?;

    // 5. Format as the wire-format envelope the frontend decoder consumes.
    //    Bytes are serialised as JSON number arrays to match the existing
    //    `wayve_encrypted` shape — same as what the deleted frontend
    //    `encryptEmail.ts` produced.
    let payload = serde_json::json!({
        "type": "wayve_encrypted",
        "data": ciphertext.iter().copied().collect::<Vec<u8>>(),
        "key":  wrapped_key.iter().copied().collect::<Vec<u8>>(),
        "iv":   nonce_bytes.iter().copied().collect::<Vec<u8>>(),
    });

    Ok(format!("{WAYVE_SECURE_PREFIX}\n{}", payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::{RsaPrivateKey, pkcs8::EncodePublicKey};

    // Generate an ephemeral keypair, encrypt a body to its public half,
    // then decrypt with the private half and confirm round-trip. The
    // wire format is exercised end-to-end including JSON shape.
    #[test]
    fn encrypt_to_pubkey_roundtrip() {
        let mut rng = thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("generate key");
        let pub_key = RsaPublicKey::from(&priv_key);
        let spki_der = pub_key.to_public_key_der().expect("encode spki").to_vec();

        let plaintext = b"hello plan A: inbound encrypt-on-arrival round trip";
        let envelope = encrypt_to_pubkey(plaintext, &spki_der).expect("encrypt");

        // Envelope MUST start with the wire prefix the frontend decoder
        // hard-codes (`WAYVE_SECURE_V1`). Catch accidental drift early.
        assert!(envelope.starts_with("WAYVE_SECURE_V1\n"));

        // Parse the JSON body and verify the field names match the
        // `wayve_encrypted` shape — also catches accidental renames.
        let json_start = envelope.find('{').expect("json start");
        let parsed: serde_json::Value =
            serde_json::from_str(&envelope[json_start..]).expect("parse json");
        assert_eq!(parsed["type"], "wayve_encrypted");
        let data: Vec<u8> = serde_json::from_value(parsed["data"].clone()).unwrap();
        let key: Vec<u8> = serde_json::from_value(parsed["key"].clone()).unwrap();
        let iv: Vec<u8> = serde_json::from_value(parsed["iv"].clone()).unwrap();
        assert_eq!(iv.len(), 12);

        // Reverse the envelope with the matching private key — mirrors
        // what the browser does in decryptMessage.
        let aes_key_bytes = priv_key
            .decrypt(Oaep::new::<Sha256>(), &key)
            .expect("rsa unwrap");
        assert_eq!(aes_key_bytes.len(), 32);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key_bytes));
        let recovered = cipher
            .decrypt(Nonce::from_slice(&iv), data.as_ref())
            .expect("aes decrypt");
        assert_eq!(recovered, plaintext);
    }

    // Encrypting the same plaintext twice MUST produce different
    // envelopes — proves the AES key and nonce are freshly random per
    // call (a regression here would leak that two identical inbound
    // emails were the same).
    #[test]
    fn encrypt_to_pubkey_is_non_deterministic() {
        let mut rng = thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("generate key");
        let spki_der = RsaPublicKey::from(&priv_key)
            .to_public_key_der()
            .expect("encode spki")
            .to_vec();

        let plaintext = b"identical body";
        let a = encrypt_to_pubkey(plaintext, &spki_der).expect("encrypt a");
        let b = encrypt_to_pubkey(plaintext, &spki_der).expect("encrypt b");
        assert_ne!(a, b, "two encryptions of the same body must differ");

        // Strip the prefix because that part is constant; the JSON
        // body is what we care about for uniqueness.
        let a_body = &a[WAYVE_SECURE_PREFIX.len()..];
        let b_body = &b[WAYVE_SECURE_PREFIX.len()..];
        assert_ne!(a_body, b_body);
    }

    // A non-RSA blob in `spki_der` must produce an error, not a panic
    // or a silently-corrupted envelope. Real bodies of email come in
    // from users.public_key which is human-populated and could be junk
    // if a future bug populates it wrong; we want a clean error here.
    #[test]
    fn encrypt_to_pubkey_rejects_garbage_key() {
        let result = encrypt_to_pubkey(b"x", b"not a real spki blob");
        assert!(result.is_err());
    }
}
