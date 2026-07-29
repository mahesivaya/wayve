// The S3 branch of `storage.rs`, exercised end to end against a mock S3 served
// by wiremock. This is the only coverage the S3 path can get without a real
// bucket, and it pins the two things most likely to be wrong: the key the
// object is written under (prefix handling), and the disk fallback that makes
// the migration safe.
//
// `S3_ENDPOINT` points the SDK at the mock, which also switches it to
// path-style addressing (`/bucket/key`) — see `storage::s3_client`.
//
// One caveat these tests live with: the SDK client is a process-wide `OnceCell`,
// so the first test to touch S3 fixes the endpoint for the whole run. That is
// why every test here shares one mock server rather than standing up its own.
#[cfg(test)]
mod tests {
    use crate::storage;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const BUCKET: &str = "wayve-test-bucket";

    /// Credentials must exist or the SDK fails before it ever calls the mock;
    /// the values are irrelevant because nothing verifies the signature.
    fn configure(endpoint: &str) {
        unsafe {
            std::env::set_var("S3_BUCKET", BUCKET);
            std::env::set_var("S3_REGION", "us-east-1");
            std::env::set_var("S3_ENDPOINT", endpoint);
            std::env::set_var("S3_PREFIX", "uploads");
            std::env::set_var("AWS_ACCESS_KEY_ID", "test");
            std::env::set_var("AWS_SECRET_ACCESS_KEY", "test");
        }
    }

    fn unconfigure() {
        unsafe {
            std::env::remove_var("S3_BUCKET");
            std::env::remove_var("S3_ENDPOINT");
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn put_writes_the_prefixed_key_and_get_reads_it_back() {
        let mock = MockServer::start().await;
        configure(&mock.uri());

        // `./uploads/abc_report.pdf` must become `uploads/abc_report.pdf` in the
        // bucket — the historical DB prefix swapped for S3_PREFIX, not appended
        // to it.
        Mock::given(method("PUT"))
            .and(path(format!("/{BUCKET}/uploads/abc_report.pdf")))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/{BUCKET}/uploads/abc_report.pdf")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"ciphertext".to_vec()))
            .expect(1)
            .mount(&mock)
            .await;

        let stored = storage::stored_path("abc_report.pdf");
        storage::put(&stored, b"ciphertext".to_vec())
            .await
            .unwrap_or_else(|e| panic!("put failed: {e}"));

        let bytes = storage::get(&stored)
            .await
            .unwrap_or_else(|e| panic!("get failed: {e}"));
        assert_eq!(bytes, b"ciphertext");

        // wiremock's `.expect(1)` assertions fire on drop, so an unexpected key
        // fails the test here.
        drop(mock);
        unconfigure();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn missing_object_falls_back_to_the_local_disk() {
        let mock = MockServer::start().await;
        configure(&mock.uri());

        let name = format!("fallback-{}.bin", uuid::Uuid::new_v4());
        let stored = storage::stored_path(&name);

        // Write the file to disk the way a pre-migration upload would have, by
        // taking the local branch with S3 unconfigured.
        unconfigure();
        storage::put(&stored, b"on-disk".to_vec())
            .await
            .unwrap_or_else(|e| panic!("local seed failed: {e}"));
        configure(&mock.uri());

        // S3 says the key isn't there; the read must still succeed.
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_string("<Error><Code>NoSuchKey</Code><Message>no</Message></Error>"),
            )
            .mount(&mock)
            .await;

        let bytes = storage::get(&stored)
            .await
            .unwrap_or_else(|e| panic!("fallback get failed: {e}"));
        assert_eq!(bytes, b"on-disk");

        unconfigure();
        let _ = tokio::fs::remove_file(format!("./uploads/{name}")).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn get_reports_not_found_when_neither_side_has_it() {
        let mock = MockServer::start().await;
        configure(&mock.uri());

        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_string("<Error><Code>NoSuchKey</Code><Message>no</Message></Error>"),
            )
            .mount(&mock)
            .await;

        let stored = storage::stored_path("definitely-absent.bin");
        let Err(err) = storage::get(&stored).await else {
            panic!("expected a miss, got bytes");
        };
        assert!(
            matches!(err, storage::StorageError::NotFound),
            "expected NotFound, got {err}"
        );

        unconfigure();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_backend_failure_is_an_error_not_a_silent_empty_read() {
        let mock = MockServer::start().await;
        configure(&mock.uri());

        // 500 is not NoSuchKey, so it must not be mistaken for "missing" and
        // must not fall through to the disk — that would mask an outage as a
        // 404 and, worse, could serve a stale local copy.
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&mock)
            .await;

        let Err(err) = storage::get(&storage::stored_path("x.bin")).await else {
            panic!("a 500 must not read as success");
        };
        assert!(
            matches!(err, storage::StorageError::Backend(_)),
            "expected Backend error, got {err}"
        );

        unconfigure();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_removes_from_both_s3_and_disk() {
        let mock = MockServer::start().await;
        configure(&mock.uri());

        let name = format!("delete-{}.bin", uuid::Uuid::new_v4());
        let stored = storage::stored_path(&name);

        // Seed a local copy, as a mid-migration file would have.
        unconfigure();
        storage::put(&stored, b"bytes".to_vec())
            .await
            .unwrap_or_else(|e| panic!("local seed failed: {e}"));
        configure(&mock.uri());

        Mock::given(method("DELETE"))
            .and(path(format!("/{BUCKET}/uploads/{name}")))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&mock)
            .await;

        storage::delete(&stored)
            .await
            .unwrap_or_else(|e| panic!("delete failed: {e}"));

        // The disk copy has to go too, or the read fallback would resurrect a
        // file the user deleted.
        unconfigure();
        assert!(
            tokio::fs::metadata(format!("./uploads/{name}"))
                .await
                .is_err(),
            "local copy survived the delete"
        );
        drop(mock);
    }
}
