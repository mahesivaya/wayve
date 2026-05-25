use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose;
use hkdf::Hkdf;
use rand::{RngCore, thread_rng};
use sha2::Sha512;

const HKDF_INFO: &[u8] = b"rwayve:v1:aes-256-gcm:messages-email-bodies";
const DEFAULT_HKDF_SALT: &[u8] = b"rwayve:v1:hkdf-sha512";

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
