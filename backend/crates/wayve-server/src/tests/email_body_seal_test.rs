//! Mailbox bodies stay sealed to their owner's public key once stored. Opening
//! an email used to refetch it from Gmail and store it back server-AES, so the
//! body endpoint must now serve a sealed body as-is, and the startup reseal
//! re-wraps bodies that an earlier open left server-readable. Owners with no
//! public key keep the server-AES fallback.

#[cfg(test)]
mod tests {
    use crate::email::body_handlers::get_email_body;
    use crate::email::body_worker::reseal_server_aes_bodies;
    use crate::test_support::{delete_user, insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use rsa::pkcs8::EncodePublicKey;
    use rsa::{RsaPrivateKey, RsaPublicKey};
    use sqlx::{PgPool, Row};
    use wayve_security::encryption::{decrypt, encrypt};

    const HEX64_TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn set_key() {
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe { std::env::set_var("AES_KEY", HEX64_TEST_KEY) };
    }

    /// `users.public_key` as the frontend writes it: a JSON array of SPKI bytes.
    fn public_key_json() -> String {
        let mut rng = rand::thread_rng();
        let private =
            RsaPrivateKey::new(&mut rng, 2048).unwrap_or_else(|err| panic!("generate key: {err}"));
        let spki = RsaPublicKey::from(&private)
            .to_public_key_der()
            .unwrap_or_else(|err| panic!("encode spki: {err}"));
        serde_json::to_string(spki.as_bytes()).unwrap_or_else(|err| panic!("json: {err}"))
    }

    /// A user with a Gmail mailbox; `public_key` is stored when given.
    async fn owner(pool: &PgPool, public_key: Option<&str>) -> (i32, String, i32) {
        let email = random_email();
        let user_id = insert_local_user(pool, &email, "Password123!").await;
        sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
            .bind(public_key)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap_or_else(|err| panic!("set public key: {err}"));
        let account_id: i32 = sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(&email)
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|err| panic!("insert account: {err}"));
        (user_id, email, account_id)
    }

    async fn insert_email(pool: &PgPool, account_id: i32, iv: &str, body: &str) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, body_iv, body_encrypted, attachments_checked)
             VALUES ($1, $2, $3, $4, true) RETURNING id",
        )
        .bind(format!("gmail-{}", uuid::Uuid::new_v4()))
        .bind(account_id)
        .bind(iv)
        .bind(body)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|err| panic!("insert email: {err}"))
    }

    async fn stored_body(pool: &PgPool, id: i32) -> (String, String) {
        let row = sqlx::query("SELECT body_iv, body_encrypted FROM emails WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|err| panic!("load email: {err}"));
        (row.get("body_iv"), row.get("body_encrypted"))
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn reseal_wraps_server_aes_bodies_to_the_owner_key() {
        set_key();
        let pool = test_pool().await;
        let (with_key, _, keyed_account) = owner(&pool, Some(&public_key_json())).await;
        let (without_key, _, keyless_account) = owner(&pool, None).await;

        let (iv, ct) =
            encrypt("opened once, stored readable").unwrap_or_else(|err| panic!("encrypt: {err}"));
        let downgraded = insert_email(&pool, keyed_account, &iv, &ct).await;
        let keyless = insert_email(&pool, keyless_account, &iv, &ct).await;

        let first = reseal_server_aes_bodies(&pool)
            .await
            .unwrap_or_else(|err| panic!("reseal: {err}"));
        assert!(first >= 1, "the downgraded row is re-sealed");

        let (new_iv, new_ct) = stored_body(&pool, downgraded).await;
        assert_eq!(new_iv, "", "a sealed body carries its own nonce");
        assert!(new_ct.starts_with("WAYVE_SECURE_V1\n"), "sealed envelope");
        assert!(
            decrypt(&new_iv, &new_ct).is_err(),
            "the server can no longer read it"
        );

        // No public key: the server-AES fallback is left untouched.
        assert_eq!(stored_body(&pool, keyless).await, (iv.clone(), ct.clone()));

        // A second run has nothing left to do for these rows.
        reseal_server_aes_bodies(&pool)
            .await
            .unwrap_or_else(|err| panic!("reseal again: {err}"));
        assert_eq!(stored_body(&pool, downgraded).await, (new_iv, new_ct));

        delete_user(&pool, with_key).await;
        delete_user(&pool, without_key).await;
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn body_endpoint_serves_a_sealed_body_without_restoring_it() {
        set_key();
        let pool = test_pool().await;
        let (user_id, email, account_id) = owner(&pool, Some(&public_key_json())).await;
        let envelope = "WAYVE_SECURE_V1\n{\"type\":\"wayve_encrypted\"}";
        let id = insert_email(&pool, account_id, "", envelope).await;

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(web::scope("/api").service(get_email_body)),
        )
        .await;
        let req = actix_test::TestRequest::get()
            .uri(&format!("/api/emails/{id}/body"))
            .insert_header((
                "Authorization",
                format!("Bearer {}", jwt_for(user_id, &email)),
            ))
            .to_request();
        let res = actix_test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = actix_test::read_body_json(res).await;

        // Served verbatim for the browser to decrypt; no Gmail refetch, so the
        // stored row is unchanged.
        assert_eq!(body["body"], envelope);
        assert_eq!(
            stored_body(&pool, id).await,
            (String::new(), envelope.to_string())
        );

        delete_user(&pool, user_id).await;
    }
}
