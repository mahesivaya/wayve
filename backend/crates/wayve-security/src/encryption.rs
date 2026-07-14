use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{RngCore, thread_rng};
use rsa::{
    Oaep, RsaPrivateKey, RsaPublicKey,
    pkcs8::{DecodePublicKey, EncodePrivateKey, EncodePublicKey},
};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Sha512};
use zeroize::Zeroize;

const HKDF_INFO: &[u8] = b"rwayve:v1:aes-256-gcm:messages-email-bodies";
const DEFAULT_HKDF_SALT: &[u8] = b"rwayve:v1:hkdf-sha512";
// Separate HKDF context keeps the address-hash HMAC key domain-separated from
// the AES key, even though both derive from `AES_KEY`. Rotating `AES_KEY` must
// wipe the `*_hash` columns in step; it is treated as forever-stable for now.
const HKDF_INFO_ADDR_HASH: &[u8] = b"rwayve:v1:hmac-sha256:email-address-hash";

/// Wire prefix for the single-recipient RSA-OAEP + AES-GCM envelope. Must match
/// the decoder in `frontend/src/emails/bodyUtils.ts` (`WAYVE_SECURE_PREFIX`).
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

    let nonce = general_purpose::STANDARD
        .decode(nonce_b64)
        .map_err(|e| format!("Nonce decode error: {:?}", e))?;

    // `Nonce::from_slice` panics on anything other than 12 bytes, so reject the
    // bad length explicitly and give callers a clean error.
    if nonce.len() != 12 {
        return Err(format!(
            "Invalid nonce length: expected 12, got {}",
            nonce.len()
        ));
    }

    let ciphertext = general_purpose::STANDARD
        .decode(cipher_b64)
        .map_err(|e| format!("Cipher decode error: {:?}", e))?;

    if ciphertext.is_empty() {
        return Err("Empty ciphertext".to_string());
    }

    let decrypted = decrypt_with_legacy_fallback(&key_bytes, &nonce, &ciphertext)?;

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

fn derive_address_hmac_key() -> Result<[u8; 32], String> {
    // Same root key material, separate HKDF context: a leaked HMAC key cannot
    // decrypt AES-GCM messages, and vice versa.
    let key_material = get_key_material()?;
    let salt = hkdf_salt();
    let hk = Hkdf::<Sha512>::new(Some(&salt), &key_material);
    let mut out = [0u8; 32];
    hk.expand(HKDF_INFO_ADDR_HASH, &mut out)
        .map_err(|_| "HKDF expand for address HMAC failed".to_string())?;
    Ok(out)
}

/// Lowercase and trim for deterministic hashing. Dots in gmail-style locals are
/// deliberately not stripped: this is equality on the literal address the user
/// typed, not RFC 5322 canonicalization.
fn normalize_address(addr: &str) -> String {
    addr.trim().to_lowercase()
}

/// Hex HMAC-SHA256 of the normalized address, stored in the `emails.*_hash`
/// columns so equality lookups run as SQL `=` without decrypting every row.
/// Being keyed by `AES_KEY`, a stolen `emails` table alone cannot be brute
/// forced. Empty input returns `None` so the caller writes SQL NULL rather than
/// the hash of an empty string.
pub fn compute_address_hash(addr: &str) -> Result<Option<String>, String> {
    let normalized = normalize_address(addr);
    if normalized.is_empty() {
        return Ok(None);
    }
    let key = derive_address_hmac_key()?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key)
        .map_err(|e| format!("hmac init failed: {e:?}"))?;
    Mac::update(&mut mac, normalized.as_bytes());
    let out = mac.finalize().into_bytes();
    Ok(Some(hex_encode(&out)))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
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

/// Build a single-recipient `WAYVE_SECURE_V1` envelope around `plaintext`, used
/// to encrypt inbound mail on arrival so the server retains nothing that can
/// decrypt it. `spki_der` is the recipient's RSA public key in SPKI DER form —
/// the bytes WebCrypto's `exportKey("spki", …)` produces, which is what
/// `users.public_key` stores as a JSON byte array.
///
/// The wire shape must stay in sync with the decoder in
/// `frontend/src/emails/bodyUtils.ts`: the prefix line, then a JSON object with
/// type `wayve_encrypted` and byte-array fields `data` (AES-GCM ciphertext),
/// `key` (RSA-OAEP-SHA256 wrapped 32-byte AES key), and `iv` (12-byte nonce).
pub fn encrypt_to_pubkey(plaintext: &[u8], spki_der: &[u8]) -> Result<String> {
    let public_key = RsaPublicKey::from_public_key_der(spki_der)
        .map_err(|e| anyhow::anyhow!("public key parse failed: {e}"))?;

    // Fresh per-record data key: never reused, so recovering one wrapped key
    // exposes only that one email.
    let mut aes_key_bytes = [0u8; 32];
    let mut nonce_bytes = [0u8; 12];
    thread_rng().fill_bytes(&mut aes_key_bytes);
    thread_rng().fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key_bytes));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow::anyhow!("AES-GCM encrypt failed: {e:?}"))?;

    // OAEP must use SHA-256 to match the hash the frontend imports the keypair
    // with (`{ name: "RSA-OAEP", hash: "SHA-256" }`).
    let padding = Oaep::new::<Sha256>();
    let wrapped_key = public_key
        .encrypt(&mut thread_rng(), padding, &aes_key_bytes)
        .map_err(|e| anyhow::anyhow!("RSA-OAEP wrap failed: {e}"))?;

    let payload = serde_json::json!({
        "type": "wayve_encrypted",
        "data": ciphertext.to_vec(),
        "key":  wrapped_key.to_vec(),
        "iv":   nonce_bytes.to_vec(),
    });

    Ok(format!("{WAYVE_SECURE_PREFIX}\n{}", payload))
}

/// PBKDF2 iteration count for the org-member login wrap. Must match
/// `PBKDF2_ITERATIONS` in `frontend/src/crypto/recovery.ts`. Persisted per row
/// in `member_login_wrapped_keys.iterations` so a future bump coexists with old
/// rows.
pub const ORG_MEMBER_PBKDF2_ITERATIONS: u32 = 600_000;

/// Password-derived wrap of a member's PKCS8 private key, base64-encoded for
/// direct insertion into `member_login_wrapped_keys`. The salt is per-user
/// random so a DB dump cannot be rainbow-tabled across users, and `iterations`
/// is recorded so the unwrap side never guesses at a stale constant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordWrappedPrivateKey {
    pub iv_b64: String,
    pub ct_b64: String,
    pub salt_b64: String,
    pub iterations: u32,
}

/// Output of `provision_org_member_keypair`. The caller persists each field;
/// it must never be logged or returned in an HTTP response.
#[derive(Debug)]
pub struct ProvisionedOrgMemberKeypair {
    /// SPKI public key bytes, JSON-encoded as a number array — the shape
    /// `users.public_key` stores.
    pub public_key_json: String,
    /// `WAYVE_SECURE_V1` envelope wrapping the PKCS8 private key under the org's
    /// RSA pubkey, for owner/admin recovery. Insert verbatim into
    /// `member_wrapped_keys.ct` (iv = "", since the envelope is self-describing).
    pub member_escrow_envelope: String,
    /// Password-derived wrap for `member_login_wrapped_keys`, which the member
    /// unwraps on a fresh device at login.
    pub login_wrap: PasswordWrappedPrivateKey,
}

/// Generate an RSA-2048 keypair for a new org member and wrap the private key
/// two ways: escrowed under the org pubkey, and under PBKDF2(password) for the
/// member's own login path.
///
/// Security boundary: the plaintext private key exists in memory only for the
/// duration of this call. Do not log it, do not carry it across `await` points,
/// and do not return it by any route other than the wrapped envelopes above.
/// The trailing `zeroize` calls overwrite the bytes on a best-effort basis.
pub fn provision_org_member_keypair(
    password: &str,
    org_public_key_spki: &[u8],
) -> Result<ProvisionedOrgMemberKeypair> {
    use pbkdf2::pbkdf2_hmac;

    let mut rng = thread_rng();
    let private_key = RsaPrivateKey::new(&mut rng, 2048)
        .map_err(|e| anyhow::anyhow!("rsa keygen failed: {e}"))?;
    let public_key = RsaPublicKey::from(&private_key);

    let pkcs8 = private_key
        .to_pkcs8_der()
        .map_err(|e| anyhow::anyhow!("pkcs8 encode failed: {e}"))?;
    let mut pkcs8_bytes: Vec<u8> = pkcs8.as_bytes().to_vec();

    let spki_bytes: Vec<u8> = public_key
        .to_public_key_der()
        .map_err(|e| anyhow::anyhow!("spki encode failed: {e}"))?
        .to_vec();

    let member_escrow_envelope = encrypt_to_pubkey(&pkcs8_bytes, org_public_key_spki)?;

    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    let mut derived = [0u8; 32];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);
    pbkdf2_hmac::<Sha256>(
        password.as_bytes(),
        &salt,
        ORG_MEMBER_PBKDF2_ITERATIONS,
        &mut derived,
    );
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&derived));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), pkcs8_bytes.as_slice())
        .map_err(|e| anyhow::anyhow!("login wrap AES-GCM failed: {e:?}"))?;

    let public_key_json = serde_json::to_string(&spki_bytes)
        .map_err(|e| anyhow::anyhow!("pubkey json encode failed: {e}"))?;

    let login_wrap = PasswordWrappedPrivateKey {
        iv_b64: general_purpose::STANDARD.encode(nonce),
        ct_b64: general_purpose::STANDARD.encode(&ciphertext),
        salt_b64: general_purpose::STANDARD.encode(salt),
        iterations: ORG_MEMBER_PBKDF2_ITERATIONS,
    };

    pkcs8_bytes.zeroize();
    derived.zeroize();
    nonce.zeroize();
    salt.zeroize();

    Ok(ProvisionedOrgMemberKeypair {
        public_key_json,
        member_escrow_envelope,
        login_wrap,
    })
}

/// Output of `provision_org_owner_keypair`: [`ProvisionedOrgMemberKeypair`]
/// without the escrow envelope, since the owner is the org's trust root and has
/// no upper key to be escrowed under.
#[derive(Debug)]
pub struct ProvisionedOrgOwnerKeypair {
    /// SPKI public key bytes, JSON-encoded — the shape `users.public_key` stores.
    pub public_key_json: String,
    /// Password-derived wrap for `member_login_wrapped_keys`, unwrapped on first
    /// login exactly as org members do.
    pub login_wrap: PasswordWrappedPrivateKey,
}

/// Generate an RSA-2048 keypair for a new org owner. The private key is wrapped
/// only under PBKDF2(password); there is no org pubkey to escrow under yet, as
/// the org master key is bootstrapped from the owner's browser after first login.
///
/// Same security boundary as `provision_org_member_keypair`.
pub fn provision_org_owner_keypair(password: &str) -> Result<ProvisionedOrgOwnerKeypair> {
    use pbkdf2::pbkdf2_hmac;

    let mut rng = thread_rng();
    let private_key = RsaPrivateKey::new(&mut rng, 2048)
        .map_err(|e| anyhow::anyhow!("rsa keygen failed: {e}"))?;
    let public_key = RsaPublicKey::from(&private_key);

    let pkcs8 = private_key
        .to_pkcs8_der()
        .map_err(|e| anyhow::anyhow!("pkcs8 encode failed: {e}"))?;
    let mut pkcs8_bytes: Vec<u8> = pkcs8.as_bytes().to_vec();

    let spki_bytes: Vec<u8> = public_key
        .to_public_key_der()
        .map_err(|e| anyhow::anyhow!("spki encode failed: {e}"))?
        .to_vec();

    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    let mut derived = [0u8; 32];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);
    pbkdf2_hmac::<Sha256>(
        password.as_bytes(),
        &salt,
        ORG_MEMBER_PBKDF2_ITERATIONS,
        &mut derived,
    );
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&derived));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), pkcs8_bytes.as_slice())
        .map_err(|e| anyhow::anyhow!("owner login wrap AES-GCM failed: {e:?}"))?;

    let public_key_json = serde_json::to_string(&spki_bytes)
        .map_err(|e| anyhow::anyhow!("pubkey json encode failed: {e}"))?;

    let login_wrap = PasswordWrappedPrivateKey {
        iv_b64: general_purpose::STANDARD.encode(nonce),
        ct_b64: general_purpose::STANDARD.encode(&ciphertext),
        salt_b64: general_purpose::STANDARD.encode(salt),
        iterations: ORG_MEMBER_PBKDF2_ITERATIONS,
    };

    pkcs8_bytes.zeroize();
    derived.zeroize();
    nonce.zeroize();
    salt.zeroize();

    Ok(ProvisionedOrgOwnerKeypair {
        public_key_json,
        login_wrap,
    })
}

/// Inverse of the `login_wrap` produced by `provision_org_member_keypair`.
/// Returns plaintext PKCS8 bytes, so the caller must not log or persist them.
pub fn unwrap_org_member_login(
    password: &str,
    wrap: &PasswordWrappedPrivateKey,
) -> Result<Vec<u8>> {
    use pbkdf2::pbkdf2_hmac;

    let salt = general_purpose::STANDARD
        .decode(&wrap.salt_b64)
        .map_err(|e| anyhow::anyhow!("salt b64 decode failed: {e}"))?;
    let iv = general_purpose::STANDARD
        .decode(&wrap.iv_b64)
        .map_err(|e| anyhow::anyhow!("iv b64 decode failed: {e}"))?;
    let ct = general_purpose::STANDARD
        .decode(&wrap.ct_b64)
        .map_err(|e| anyhow::anyhow!("ct b64 decode failed: {e}"))?;
    if iv.len() != 12 {
        return Err(anyhow::anyhow!("login wrap iv has wrong length"));
    }

    let mut derived = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, wrap.iterations, &mut derived);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&derived));
    let pkcs8 = cipher
        .decrypt(Nonce::from_slice(&iv), ct.as_slice())
        .map_err(|e| anyhow::anyhow!("login unwrap failed (wrong password?): {e:?}"))?;
    derived.zeroize();
    Ok(pkcs8)
}

/// Re-wrap a member's PKCS8 private key under a new password with a fresh salt
/// and IV. Used by both the member password-change and the admin-driven
/// password-reset paths.
pub fn rewrap_org_member_login(
    new_password: &str,
    pkcs8_bytes: &[u8],
) -> Result<PasswordWrappedPrivateKey> {
    use pbkdf2::pbkdf2_hmac;

    let mut rng = thread_rng();
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    let mut derived = [0u8; 32];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);
    pbkdf2_hmac::<Sha256>(
        new_password.as_bytes(),
        &salt,
        ORG_MEMBER_PBKDF2_ITERATIONS,
        &mut derived,
    );
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&derived));
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), pkcs8_bytes)
        .map_err(|e| anyhow::anyhow!("rewrap AES-GCM failed: {e:?}"))?;
    derived.zeroize();
    let out = PasswordWrappedPrivateKey {
        iv_b64: general_purpose::STANDARD.encode(nonce),
        ct_b64: general_purpose::STANDARD.encode(&ct),
        salt_b64: general_purpose::STANDARD.encode(salt),
        iterations: ORG_MEMBER_PBKDF2_ITERATIONS,
    };
    nonce.zeroize();
    salt.zeroize();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::DecodePrivateKey;

    #[test]
    fn encrypt_to_pubkey_roundtrip() {
        let mut rng = thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("generate key");
        let pub_key = RsaPublicKey::from(&priv_key);
        let spki_der = pub_key.to_public_key_der().expect("encode spki").to_vec();

        let plaintext = b"hello plan A: inbound encrypt-on-arrival round trip";
        let envelope = encrypt_to_pubkey(plaintext, &spki_der).expect("encrypt");

        // The prefix and JSON field names are hard-coded in the frontend decoder,
        // so assert on them to catch wire-format drift.
        assert!(envelope.starts_with("WAYVE_SECURE_V1\n"));

        let json_start = envelope.find('{').expect("json start");
        let parsed: serde_json::Value =
            serde_json::from_str(&envelope[json_start..]).expect("parse json");
        assert_eq!(parsed["type"], "wayve_encrypted");
        let data: Vec<u8> = serde_json::from_value(parsed["data"].clone()).unwrap();
        let key: Vec<u8> = serde_json::from_value(parsed["key"].clone()).unwrap();
        let iv: Vec<u8> = serde_json::from_value(parsed["iv"].clone()).unwrap();
        assert_eq!(iv.len(), 12);

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

    // The AES key and nonce must be freshly random per call; otherwise identical
    // inbound emails would produce identical envelopes and leak that fact.
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

        let a_body = &a[WAYVE_SECURE_PREFIX.len()..];
        let b_body = &b[WAYVE_SECURE_PREFIX.len()..];
        assert_ne!(a_body, b_body);
    }

    // A junk `users.public_key` must yield an error, never a panic or a
    // silently-corrupted envelope.
    #[test]
    fn encrypt_to_pubkey_rejects_garbage_key() {
        let result = encrypt_to_pubkey(b"x", b"not a real spki blob");
        assert!(result.is_err());
    }

    // Both wrapping paths must describe the same underlying keypair: the org
    // escrow and the password login wrap have to unwrap to identical PKCS8.
    #[test]
    fn provision_org_member_keypair_double_wrap_roundtrip() {
        let mut rng = thread_rng();
        let org_priv = RsaPrivateKey::new(&mut rng, 2048).expect("org keygen");
        let org_spki = RsaPublicKey::from(&org_priv)
            .to_public_key_der()
            .expect("org spki")
            .to_vec();

        let password = "correct-horse-battery-staple";
        let result = provision_org_member_keypair(password, &org_spki).expect("provision succeeds");

        // Owner recovers PKCS8 from the org-pubkey-wrapped envelope.
        let prefix_len = WAYVE_SECURE_PREFIX.len() + 1;
        let json_str = &result.member_escrow_envelope[prefix_len..];
        let parsed: serde_json::Value = serde_json::from_str(json_str).expect("json");
        let wrapped_aes: Vec<u8> =
            serde_json::from_value(parsed["key"].clone()).expect("wrapped key");
        let body_ct: Vec<u8> =
            serde_json::from_value(parsed["data"].clone()).expect("body ciphertext");
        let body_iv: Vec<u8> = serde_json::from_value(parsed["iv"].clone()).expect("body iv");
        let aes_key = org_priv
            .decrypt(Oaep::new::<Sha256>(), &wrapped_aes)
            .expect("rsa unwrap");
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key));
        let pkcs8_via_org = cipher
            .decrypt(Nonce::from_slice(&body_iv), body_ct.as_ref())
            .expect("aes unwrap via org key");

        // Member recovers the same PKCS8 from the password wrap.
        let pkcs8_via_password =
            unwrap_org_member_login(password, &result.login_wrap).expect("login unwrap");

        assert_eq!(pkcs8_via_org, pkcs8_via_password);

        // The recovered key must parse and imply the published SPKI bytes.
        let recovered = RsaPrivateKey::from_pkcs8_der(&pkcs8_via_org).expect("pkcs8 parse");
        let recovered_spki = RsaPublicKey::from(&recovered)
            .to_public_key_der()
            .expect("recovered spki")
            .to_vec();
        let pub_json: Vec<u8> = serde_json::from_str(&result.public_key_json).expect("pub json");
        assert_eq!(recovered_spki, pub_json);
    }

    // A wrong password must fail on the AES-GCM auth tag, never return junk PKCS8.
    #[test]
    fn unwrap_org_member_login_rejects_wrong_password() {
        let mut rng = thread_rng();
        let org_priv = RsaPrivateKey::new(&mut rng, 2048).expect("org keygen");
        let org_spki = RsaPublicKey::from(&org_priv)
            .to_public_key_der()
            .expect("org spki")
            .to_vec();

        let result = provision_org_member_keypair("right-password", &org_spki).expect("provision");
        let wrong = unwrap_org_member_login("wrong-password", &result.login_wrap);
        assert!(wrong.is_err(), "wrong password must reject");
    }

    #[test]
    fn rewrap_org_member_login_roundtrip() {
        let mut rng = thread_rng();
        let org_priv = RsaPrivateKey::new(&mut rng, 2048).expect("org keygen");
        let org_spki = RsaPublicKey::from(&org_priv)
            .to_public_key_der()
            .expect("org spki")
            .to_vec();

        let initial = provision_org_member_keypair("old-pass", &org_spki).expect("provision");
        let pkcs8 = unwrap_org_member_login("old-pass", &initial.login_wrap).expect("unwrap");

        let new_wrap = rewrap_org_member_login("new-pass", &pkcs8).expect("rewrap");
        let pkcs8_via_new = unwrap_org_member_login("new-pass", &new_wrap).expect("unwrap via new");
        assert_eq!(pkcs8, pkcs8_via_new);

        assert_ne!(initial.login_wrap.salt_b64, new_wrap.salt_b64);
    }
}
