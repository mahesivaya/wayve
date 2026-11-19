//! The keys derived from `AES_KEY` are built once and reused, and are still the
//! same keys as before: everything already stored (encrypted bodies, messages,
//! tokens, and the address and thread hashes that rows are looked up by) must
//! keep working. They are re-derived when `AES_KEY` or `AES_HKDF_SALT` changes,
//! rather than kept from whichever key was seen first.

#[cfg(test)]
mod tests {
    use aes_gcm::{
        Aes256Gcm, Key, Nonce,
        aead::{Aead, KeyInit},
    };
    use base64::Engine;
    use base64::engine::general_purpose;
    use hkdf::Hkdf;
    use hmac::{Hmac, Mac};
    use sha2::{Sha256, Sha512};
    use wayve_security::encryption::{
        compute_address_hash, compute_thread_key_hash, decrypt, encrypt,
    };

    const KEY_A: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const KEY_B: &str = "f0e0d0c0b0a090807060504030201000ffeeddccbbaa99887766554433221100";
    const DEFAULT_SALT: &[u8] = b"rwayve:v1:hkdf-sha512";
    const AES_INFO: &[u8] = b"rwayve:v1:aes-256-gcm:messages-email-bodies";
    const HASH_INFO: &[u8] = b"rwayve:v1:hmac-sha256:email-address-hash";

    fn use_key(key: &str, salt: Option<&str>) {
        unsafe {
            std::env::set_var("AES_KEY", key);
            match salt {
                Some(salt) => std::env::set_var("AES_HKDF_SALT", salt),
                None => std::env::remove_var("AES_HKDF_SALT"),
            }
        }
    }

    fn hex_key(hex: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .unwrap_or_else(|e| panic!("hex: {e}"));
        }
        out
    }

    /// The derivation as it is specified, done by hand.
    fn derive(hex: &str, salt: &[u8], info: &[u8]) -> [u8; 32] {
        let hk = Hkdf::<Sha512>::new(Some(salt), &hex_key(hex));
        let mut out = [0u8; 32];
        hk.expand(info, &mut out)
            .unwrap_or_else(|e| panic!("hkdf: {e:?}"));
        out
    }

    fn hmac_hex(key: &[u8; 32], parts: &[&[u8]]) -> String {
        let mut mac =
            <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap_or_else(|e| panic!("hmac: {e:?}"));
        for part in parts {
            Mac::update(&mut mac, part);
        }
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn encrypt_with(key: &[u8; 32], plaintext: &str) -> (String, String) {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
        let nonce = [9u8; 12];
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
            .unwrap_or_else(|e| panic!("encrypt: {e:?}"));
        (
            general_purpose::STANDARD.encode(nonce),
            general_purpose::STANDARD.encode(ciphertext),
        )
    }

    fn hash(addr: &str) -> String {
        compute_address_hash(addr)
            .unwrap_or_else(|e| panic!("hash: {e}"))
            .unwrap_or_else(|| panic!("hash: nothing for {addr}"))
    }

    #[test]
    #[serial_test::serial]
    fn cached_keys_are_the_keys_the_stored_data_was_written_with() {
        use_key(KEY_A, None);

        // Ciphertext made with the key as specified decrypts.
        let aes = derive(KEY_A, DEFAULT_SALT, AES_INFO);
        let (nonce, ciphertext) = encrypt_with(&aes, "stored before the change");
        assert_eq!(
            decrypt(&nonce, &ciphertext).unwrap_or_else(|e| panic!("decrypt: {e}")),
            "stored before the change"
        );

        // Address and thread hashes are byte-for-byte what they were, or rows
        // already stored could no longer be found by them.
        let mac = derive(KEY_A, DEFAULT_SALT, HASH_INFO);
        assert_eq!(
            hash("  Ada@Example.COM "),
            hmac_hex(&mac, &[b"ada@example.com"])
        );
        assert_eq!(
            compute_thread_key_hash("subject", "hello")
                .unwrap_or_else(|e| panic!("thread hash: {e}"))
                .unwrap_or_else(|| panic!("thread hash: nothing")),
            hmac_hex(&mac, &[b"thread-key\0", b"subject", b"\0", b"hello"])
        );

        // And repeated use (now served from the cache) gives the same answers.
        for _ in 0..3 {
            assert_eq!(
                hash("ada@example.com"),
                hmac_hex(&mac, &[b"ada@example.com"])
            );
            let (n, c) = encrypt("round trip").unwrap_or_else(|e| panic!("encrypt: {e}"));
            assert_eq!(
                decrypt(&n, &c).unwrap_or_else(|e| panic!("decrypt: {e}")),
                "round trip"
            );
        }
    }

    #[test]
    #[serial_test::serial]
    fn a_changed_key_is_picked_up_not_kept_from_the_first_use() {
        use_key(KEY_A, None);
        let (nonce, ciphertext) = encrypt("written under A").unwrap_or_else(|e| panic!("{e}"));
        let hash_a = hash("ada@example.com");

        use_key(KEY_B, None);
        assert!(
            decrypt(&nonce, &ciphertext).is_err(),
            "key B must not open what key A wrote"
        );
        let hash_b = hash("ada@example.com");
        assert_ne!(hash_a, hash_b);
        assert_eq!(
            hash_b,
            hmac_hex(
                &derive(KEY_B, DEFAULT_SALT, HASH_INFO),
                &[b"ada@example.com"]
            )
        );

        use_key(KEY_A, None);
        assert_eq!(
            decrypt(&nonce, &ciphertext).unwrap_or_else(|e| panic!("decrypt: {e}")),
            "written under A"
        );
        assert_eq!(hash("ada@example.com"), hash_a);
    }

    #[test]
    #[serial_test::serial]
    fn a_changed_salt_is_picked_up_too() {
        use_key(KEY_A, Some("custom-salt"));
        let (nonce, ciphertext) = encrypt("salted").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            hash("ada@example.com"),
            hmac_hex(
                &derive(KEY_A, b"custom-salt", HASH_INFO),
                &[b"ada@example.com"]
            )
        );

        use_key(KEY_A, None);
        assert!(decrypt(&nonce, &ciphertext).is_err());

        use_key(KEY_A, Some("custom-salt"));
        assert_eq!(
            decrypt(&nonce, &ciphertext).unwrap_or_else(|e| panic!("decrypt: {e}")),
            "salted"
        );
        use_key(KEY_A, None);
    }

    #[test]
    #[serial_test::serial]
    fn rows_written_with_the_raw_key_still_open() {
        // Before HKDF, AES_KEY was used directly. That fallback reads the key
        // fresh, so it follows a key change as well.
        use_key(KEY_B, None);
        let (nonce, ciphertext) = encrypt_with(&hex_key(KEY_B), "legacy row");
        assert_eq!(
            decrypt(&nonce, &ciphertext).unwrap_or_else(|e| panic!("decrypt: {e}")),
            "legacy row"
        );
        use_key(KEY_A, None);
        assert!(decrypt(&nonce, &ciphertext).is_err());
    }

    #[test]
    #[serial_test::serial]
    fn without_a_key_it_fails_every_time_and_recovers_once_set() {
        unsafe {
            std::env::remove_var("AES_KEY");
        }
        for _ in 0..2 {
            let err = encrypt("x")
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default();
            assert!(err.contains("AES_KEY is not set"), "got: {err}");
            assert!(compute_address_hash("ada@example.com").is_err());
        }
        use_key(KEY_A, None);
        let (n, c) = encrypt("back").unwrap_or_else(|e| panic!("encrypt: {e}"));
        assert_eq!(
            decrypt(&n, &c).unwrap_or_else(|e| panic!("decrypt: {e}")),
            "back"
        );
    }
}
