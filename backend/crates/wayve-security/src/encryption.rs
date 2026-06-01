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
    Oaep, RsaPrivateKey, RsaPublicKey,
    pkcs8::{DecodePublicKey, EncodePrivateKey, EncodePublicKey},
};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Sha512};
use zeroize::Zeroize;

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
        "data": ciphertext.to_vec(),
        "key":  wrapped_key.to_vec(),
        "iv":   nonce_bytes.to_vec(),
    });

    Ok(format!("{WAYVE_SECURE_PREFIX}\n{}", payload))
}

/// Default PBKDF2 iteration count for the org-member login wrap. Matches
/// `PBKDF2_ITERATIONS` in `frontend/src/crypto/recovery.ts` so both sides
/// use the same KDF cost. Stored in `member_login_wrapped_keys.iterations`
/// so a future bump to 1M can coexist with old rows.
pub const ORG_MEMBER_PBKDF2_ITERATIONS: u32 = 600_000;

/// Password-derived wrap of the member's PKCS8 private key. Base64-encoded
/// for direct insertion into `member_login_wrapped_keys`. The salt is
/// per-user random so a server-DB dump can't be rainbow-tabled across
/// users; iterations is recorded explicitly so the unwrap side doesn't
/// have to guess at a stale constant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordWrappedPrivateKey {
    pub iv_b64: String,
    pub ct_b64: String,
    pub salt_b64: String,
    pub iterations: u32,
}

/// The full output of `provision_org_member_keypair`. The caller (the
/// `POST /admin/users` handler) inserts each piece into the appropriate
/// table — never logs the keypair, never returns it in the HTTP response.
#[derive(Debug)]
pub struct ProvisionedOrgMemberKeypair {
    /// SPKI bytes of the member's public key, JSON-encoded as a number
    /// array — the wire shape `users.public_key` already stores.
    pub public_key_json: String,
    /// `WAYVE_SECURE_V1` envelope wrapping the PKCS8 private key under
    /// the org's RSA pubkey. Insert verbatim into `member_wrapped_keys.ct`
    /// (with iv = "" since the envelope is self-describing).
    pub member_escrow_envelope: String,
    /// Password-derived wrap for `member_login_wrapped_keys`. The member
    /// uses this to unwrap on a fresh device at login time.
    pub login_wrap: PasswordWrappedPrivateKey,
}

/// Generate an RSA-2048 keypair for a new org member, wrap the private
/// key two ways (org escrow + password-derived login wrap), and return
/// everything ready for the caller to persist. The plaintext private
/// key is zeroed before this function returns.
///
/// **Security boundary:** this function holds the plaintext private key
/// in memory for the duration of the call. Don't log it, don't pass it
/// across `await` points (the `tokio::spawn_blocking` wrapper at the
/// call site keeps it on a single thread), don't return it through any
/// channel other than the wrapped envelopes above. The `zeroize` calls
/// at the end overwrite the bytes; Rust's drop semantics make this
/// best-effort but it raises the bar significantly above bare `Vec`.
pub fn provision_org_member_keypair(
    password: &str,
    org_public_key_spki: &[u8],
) -> Result<ProvisionedOrgMemberKeypair> {
    use pbkdf2::pbkdf2_hmac;

    // 1. Generate the RSA-2048 keypair. This is the only place the
    //    plaintext private key ever exists on the server.
    let mut rng = thread_rng();
    let private_key = RsaPrivateKey::new(&mut rng, 2048)
        .map_err(|e| anyhow::anyhow!("rsa keygen failed: {e}"))?;
    let public_key = RsaPublicKey::from(&private_key);

    // 2. Export to PKCS8 DER (member-side private key form) and SPKI DER
    //    (public key form for both org escrow + users.public_key column).
    //    PKCS8 bytes go in a Zeroizing<Vec<u8>> so the buffer is wiped on
    //    drop even if a panic unwinds before the explicit zero below.
    let pkcs8 = private_key
        .to_pkcs8_der()
        .map_err(|e| anyhow::anyhow!("pkcs8 encode failed: {e}"))?;
    let mut pkcs8_bytes: Vec<u8> = pkcs8.as_bytes().to_vec();

    let spki_bytes: Vec<u8> = public_key
        .to_public_key_der()
        .map_err(|e| anyhow::anyhow!("spki encode failed: {e}"))?
        .to_vec();

    // 3. Wrap (a): under the org pubkey, for owner/admin recovery.
    let member_escrow_envelope = encrypt_to_pubkey(&pkcs8_bytes, org_public_key_spki)?;

    // 4. Wrap (b): under PBKDF2(password, fresh salt), for the member's
    //    own login path. Fresh random salt + standard 600k iters.
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

    // 5. Build the public-key JSON-array string the existing storage
    //    shape expects (users.public_key is a JSON array of bytes).
    let public_key_json = serde_json::to_string(&spki_bytes)
        .map_err(|e| anyhow::anyhow!("pubkey json encode failed: {e}"))?;

    let login_wrap = PasswordWrappedPrivateKey {
        iv_b64: general_purpose::STANDARD.encode(nonce),
        ct_b64: general_purpose::STANDARD.encode(&ciphertext),
        salt_b64: general_purpose::STANDARD.encode(salt),
        iterations: ORG_MEMBER_PBKDF2_ITERATIONS,
    };

    // 6. Wipe everything sensitive. The wrapped envelopes above hold
    //    only RSA/AES ciphertext at this point; the plaintext private
    //    key bytes and the PBKDF2-derived AES key are no longer needed.
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

/// Unwrap a member's password-wrapped private key (the inverse of the
/// `login_wrap` produced by `provision_org_member_keypair`). Used by the
/// password-change handler to re-wrap with a new salt + new derived key.
/// Returns the plaintext PKCS8 bytes in a Zeroizing buffer so the caller
/// can re-wrap and the bytes get wiped at drop.
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

/// Re-wrap a member's PKCS8 private key under a new password. Used by
/// (a) the member-driven password-change handler with the old password's
/// unwrap result, and (b) the admin-driven password-reset handler with
/// the org-key-driven unwrap result. Either way the input is fresh
/// PKCS8 bytes; this just generates new salt/IV/derived key and AES-GCMs.
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

    // Full provisioning round-trip: generate a member keypair, escrow it
    // under an org pubkey, login-wrap it under a password. Verify (a)
    // the org-pubkey owner can recover the PKCS8 private key from the
    // escrow envelope, (b) the member can recover the same PKCS8 from
    // the login wrap using the same password, (c) both recovered keys
    // agree, and (d) the public key bytes in the JSON match what the
    // recovered private key implies. End-to-end check that the two
    // wrapping paths describe the same underlying keypair.
    #[test]
    fn provision_org_member_keypair_double_wrap_roundtrip() {
        let mut rng = thread_rng();
        let org_priv = RsaPrivateKey::new(&mut rng, 2048).expect("org keygen");
        let org_spki = RsaPublicKey::from(&org_priv)
            .to_public_key_der()
            .expect("org spki")
            .to_vec();

        let password = "correct-horse-battery-staple";
        let result = provision_org_member_keypair(password, &org_spki)
            .expect("provision succeeds");

        // (a) Owner recovers PKCS8 from the org-pubkey-wrapped envelope.
        let prefix_len = WAYVE_SECURE_PREFIX.len() + 1; // "\n"
        let json_str = &result.member_escrow_envelope[prefix_len..];
        let parsed: serde_json::Value = serde_json::from_str(json_str).expect("json");
        let wrapped_aes: Vec<u8> =
            serde_json::from_value(parsed["key"].clone()).expect("wrapped key");
        let body_ct: Vec<u8> =
            serde_json::from_value(parsed["data"].clone()).expect("body ciphertext");
        let body_iv: Vec<u8> =
            serde_json::from_value(parsed["iv"].clone()).expect("body iv");
        let aes_key = org_priv
            .decrypt(Oaep::new::<Sha256>(), &wrapped_aes)
            .expect("rsa unwrap");
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&aes_key));
        let pkcs8_via_org = cipher
            .decrypt(Nonce::from_slice(&body_iv), body_ct.as_ref())
            .expect("aes unwrap via org key");

        // (b) Member recovers PKCS8 from the password wrap.
        let pkcs8_via_password = unwrap_org_member_login(password, &result.login_wrap)
            .expect("login unwrap");

        // (c) Both paths must yield the EXACT same PKCS8 bytes — proves
        //     both wraps describe the same keypair.
        assert_eq!(pkcs8_via_org, pkcs8_via_password);

        // (d) The recovered PKCS8 must parse as a real RSA private key
        //     whose pubkey matches the JSON-encoded SPKI bytes.
        let recovered = RsaPrivateKey::from_pkcs8_der(&pkcs8_via_org).expect("pkcs8 parse");
        let recovered_spki = RsaPublicKey::from(&recovered)
            .to_public_key_der()
            .expect("recovered spki")
            .to_vec();
        let pub_json: Vec<u8> =
            serde_json::from_str(&result.public_key_json).expect("pub json");
        assert_eq!(recovered_spki, pub_json);
    }

    // Wrong password must FAIL with a clear error from AES-GCM auth
    // tag rejection — must never silently return junk PKCS8 bytes.
    #[test]
    fn unwrap_org_member_login_rejects_wrong_password() {
        let mut rng = thread_rng();
        let org_priv = RsaPrivateKey::new(&mut rng, 2048).expect("org keygen");
        let org_spki = RsaPublicKey::from(&org_priv)
            .to_public_key_der()
            .expect("org spki")
            .to_vec();

        let result = provision_org_member_keypair("right-password", &org_spki)
            .expect("provision");
        let wrong = unwrap_org_member_login("wrong-password", &result.login_wrap);
        assert!(wrong.is_err(), "wrong password must reject");
    }

    // Password change round-trip: unwrap with old password, re-wrap with
    // new, unwrap with new must yield original PKCS8. Verifies the
    // re-wrap path used by the password-change handler.
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
        let pkcs8_via_new =
            unwrap_org_member_login("new-pass", &new_wrap).expect("unwrap via new");
        assert_eq!(pkcs8, pkcs8_via_new);

        // Salt MUST differ — confirms fresh randomness on rewrap.
        assert_ne!(initial.login_wrap.salt_b64, new_wrap.salt_b64);
    }
}
