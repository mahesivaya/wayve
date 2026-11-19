//! File encryption at rest runs on the blocking thread pool
//! (`storage::encrypt_file` / `decrypt_file`) so a 50 MB upload or download
//! doesn't stall the single-threaded Actix worker it arrived on. The bytes must
//! come back exactly, a wrong nonce must fail cleanly, and the request thread
//! must stay free while a big file is being encrypted.

#[cfg(test)]
mod tests {
    use crate::storage::{decrypt_file, encrypt_file};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn set_test_key() {
        unsafe { std::env::set_var("AES_KEY", HEX64_TEST_KEY) };
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_file_comes_back_byte_for_byte() {
        set_test_key();
        let plaintext: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();

        let (iv, ciphertext) = encrypt_file(plaintext.clone())
            .await
            .unwrap_or_else(|e| panic!("encrypt: {e}"));
        assert_ne!(ciphertext, plaintext, "stored bytes are not the plaintext");
        // AES-GCM appends its 16-byte tag.
        assert_eq!(ciphertext.len(), plaintext.len() + 16);

        let back = decrypt_file(iv, ciphertext)
            .await
            .unwrap_or_else(|e| panic!("decrypt: {e}"));
        assert_eq!(back, plaintext);
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn an_empty_file_and_the_old_inline_format_still_open() {
        set_test_key();
        // An upload of zero bytes still stores a tag and opens again.
        let (iv, ciphertext) = encrypt_file(Vec::new())
            .await
            .unwrap_or_else(|e| panic!("encrypt: {e}"));
        let back = decrypt_file(iv, ciphertext)
            .await
            .unwrap_or_else(|e| panic!("decrypt: {e}"));
        assert!(back.is_empty());

        // Files stored before this change were sealed by the same function,
        // inline; they open unchanged.
        let (iv, ciphertext) = wayve_security::encryption::encrypt_binary(b"stored earlier")
            .unwrap_or_else(|e| panic!("encrypt: {e}"));
        let back = decrypt_file(iv, ciphertext)
            .await
            .unwrap_or_else(|e| panic!("decrypt: {e}"));
        assert_eq!(back, b"stored earlier");
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_wrong_nonce_is_an_error_not_a_panic() {
        set_test_key();
        let (_, ciphertext) = encrypt_file(b"secret".to_vec())
            .await
            .unwrap_or_else(|e| panic!("encrypt: {e}"));
        let other_iv = encrypt_file(b"x".to_vec())
            .await
            .unwrap_or_else(|e| panic!("encrypt: {e}"))
            .0;
        assert!(decrypt_file(other_iv, ciphertext.clone()).await.is_err());
        // A malformed nonce is refused before AES-GCM sees it.
        assert!(
            decrypt_file("not-base64!".to_string(), ciphertext)
                .await
                .is_err()
        );
    }

    /// The test runtime is single-threaded, like an Actix worker. While a large
    /// file is encrypted, a ticker on the same thread must keep running; done
    /// inline, it would not tick at all until the encryption finished.
    #[actix_web::test]
    #[serial_test::serial]
    async fn the_request_thread_stays_free_while_a_big_file_encrypts() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        set_test_key();
        let plaintext = vec![7u8; 32 * 1024 * 1024];
        let done = Arc::new(AtomicBool::new(false));
        let ticks = Arc::new(AtomicUsize::new(0));
        let ticker = {
            let (done, ticks) = (done.clone(), ticks.clone());
            actix_web::rt::spawn(async move {
                while !done.load(Ordering::SeqCst) {
                    ticks.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                }
            })
        };

        let (iv, ciphertext) = encrypt_file(plaintext)
            .await
            .unwrap_or_else(|e| panic!("encrypt: {e}"));
        done.store(true, Ordering::SeqCst);
        ticker.await.unwrap_or_else(|e| panic!("ticker: {e}"));

        assert!(
            ticks.load(Ordering::SeqCst) > 1,
            "the worker thread was blocked for the whole encryption"
        );
        assert_eq!(
            decrypt_file(iv, ciphertext)
                .await
                .unwrap_or_else(|e| panic!("decrypt: {e}"))
                .len(),
            32 * 1024 * 1024
        );
    }
}
