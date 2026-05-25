#[cfg(test)]
mod tests {
    use wayve_security::encryption::{decrypt, encrypt};
    use aes_gcm::{
        Aes256Gcm, Key, Nonce,
        aead::{Aead, KeyInit},
    };
    use base64::Engine;
    use base64::engine::general_purpose;

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn set_test_key() {
        unsafe {
            std::env::set_var("AES_KEY", HEX64_TEST_KEY);
        }
    }

    #[test]
    #[serial_test::serial]
    fn round_trip() {
        set_test_key();
        let plaintext = "the quick brown fox";
        let (nonce, cipher) = encrypt(plaintext).unwrap();
        assert_ne!(cipher, plaintext, "ciphertext must not equal plaintext");
        let decrypted = decrypt(&nonce, &cipher).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    #[serial_test::serial]
    fn each_call_uses_fresh_nonce() {
        set_test_key();
        let (n1, c1) = encrypt("same input").unwrap();
        let (n2, c2) = encrypt("same input").unwrap();
        assert_ne!(n1, n2, "nonces must differ");
        assert_ne!(c1, c2, "ciphertexts must differ for the same plaintext");
    }

    #[test]
    #[serial_test::serial]
    fn rejects_short_nonce() {
        set_test_key();
        let err = decrypt("AAAA", "any").unwrap_err();
        assert!(err.contains("Invalid nonce length"), "got: {err}");
    }

    #[test]
    #[serial_test::serial]
    fn rejects_empty_ciphertext() {
        set_test_key();
        let (nonce, _) = encrypt("hello").unwrap();
        let err = decrypt(&nonce, "").unwrap_err();
        assert!(err.contains("Empty"), "got: {err}");
    }

    #[test]
    #[serial_test::serial]
    fn rejects_tampered_ciphertext() {
        set_test_key();
        let (nonce, cipher) = encrypt("sensitive").unwrap();
        // Flip the first character of ciphertext.
        let mut bytes = cipher.into_bytes();
        bytes[0] = bytes[0].wrapping_add(1);
        let tampered = String::from_utf8(bytes).unwrap();
        assert!(decrypt(&nonce, &tampered).is_err());
    }

    #[test]
    #[serial_test::serial]
    fn decrypts_legacy_direct_32_byte_key_ciphertext() {
        unsafe {
            std::env::set_var("AES_KEY", "0123456789abcdef0123456789abcdef");
        }

        let key = *b"0123456789abcdef0123456789abcdef";
        let (nonce, cipher) = encrypt_with_direct_key(&key, "legacy key");
        let decrypted = decrypt(&nonce, &cipher).unwrap();
        assert_eq!(decrypted, "legacy key");
    }

    #[test]
    #[serial_test::serial]
    fn decrypts_legacy_direct_hex64_key_ciphertext() {
        set_test_key();

        let mut key = [0u8; 32];
        for (idx, byte) in key.iter_mut().enumerate() {
            *byte = idx as u8;
        }

        let (nonce, cipher) = encrypt_with_direct_key(&key, "legacy hex64 key");
        let decrypted = decrypt(&nonce, &cipher).unwrap();
        assert_eq!(decrypted, "legacy hex64 key");
    }

    fn encrypt_with_direct_key(key_bytes: &[u8; 32], plaintext: &str) -> (String, String) {
        let key = Key::<Aes256Gcm>::from_slice(key_bytes);
        let cipher = Aes256Gcm::new(key);
        let nonce_bytes = [7u8; 12];
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
            .unwrap();

        (
            general_purpose::STANDARD.encode(nonce_bytes),
            general_purpose::STANDARD.encode(ciphertext),
        )
    }
}
