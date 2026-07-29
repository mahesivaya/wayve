//! Where user-uploaded bytes live: the local disk, or S3.
//!
//! Every upload path in the app (drive files, task / ticket / support / chat
//! attachments, org documents, avatars) goes through `put` / `get` / `delete`
//! here instead of touching `tokio::fs` directly, so the storage backend is one
//! decision made in one place.
//!
//! **The database is unchanged.** Rows keep storing the same `./uploads/<name>`
//! strings they always did; that string is the storage key. On disk it is a
//! path; in S3 the `./uploads/` prefix is swapped for `S3_PREFIX`. So switching
//! backends needs no migration of `file_path` columns, and switching back works
//! too.
//!
//! Reads fall back to disk when S3 doesn't have the object. That is what makes
//! the migration safe: turn `S3_BUCKET` on, and files uploaded before the switch
//! still serve from the volume while new ones go to the bucket. Once
//! `aws s3 sync` has copied the backlog up, the fallback simply stops firing.
//!
//! Bytes arrive here already encrypted (`encryption::encrypt_binary`) for every
//! caller except avatars, so S3 never sees plaintext regardless of bucket
//! settings.

use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use tracing::info;

/// Root for local-disk storage, and the prefix historical `file_path` values
/// carry. Relative to the process working directory (`/app` in the container).
const LOCAL_ROOT: &str = "./uploads";

#[derive(Debug)]
pub enum StorageError {
    /// No object/file for this key. Callers map this to 404 rather than 500.
    NotFound,
    Backend(String),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::NotFound => write!(f, "file not found"),
            StorageError::Backend(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            StorageError::NotFound
        } else {
            StorageError::Backend(err.to_string())
        }
    }
}

type Result<T> = std::result::Result<T, StorageError>;

/// The object key for a stored path: `./uploads/a_b.png` → `a_b.png`,
/// `/uploads/x` → `x`, `avatars/y` → `avatars/y`. Tolerates the leading-slash
/// form that predates this module, and refuses to walk out of the root.
fn relative_key(stored_path: &str) -> Result<String> {
    let trimmed = stored_path.trim();
    let without_root = trimmed
        .strip_prefix("./uploads/")
        .or_else(|| trimmed.strip_prefix("/uploads/"))
        .or_else(|| trimmed.strip_prefix("uploads/"))
        .unwrap_or_else(|| trimmed.trim_start_matches('/'));

    // `..` in a key would escape the uploads root on disk and confuse S3 key
    // handling. Nothing legitimate generates it — every caller builds keys from
    // a UUID — so treat it as a hard error rather than sanitising silently.
    if without_root.is_empty() || without_root.split('/').any(|part| part == "..") {
        return Err(StorageError::Backend(format!(
            "refusing unsafe storage key: {stored_path}"
        )));
    }
    Ok(without_root.to_string())
}

fn local_path(stored_path: &str) -> Result<PathBuf> {
    Ok(Path::new(LOCAL_ROOT).join(relative_key(stored_path)?))
}

fn s3_key(stored_path: &str) -> Result<String> {
    let prefix = crate::config::s3_prefix();
    let key = relative_key(stored_path)?;
    Ok(if prefix.is_empty() {
        key
    } else {
        format!("{prefix}/{key}")
    })
}

/// The stored-path form callers persist in `file_path` columns. Kept here so the
/// one place that knows the layout is this module.
pub fn stored_path(name: &str) -> String {
    format!("{LOCAL_ROOT}/{name}")
}

/// Built once per process. `OnceCell` rather than `lazy_static` because building
/// it is async (the SDK resolves region + credentials from the environment, and
/// on EC2 that means a call to the instance metadata service).
static S3: tokio::sync::OnceCell<aws_sdk_s3::Client> = tokio::sync::OnceCell::const_new();

async fn s3_client() -> &'static aws_sdk_s3::Client {
    S3.get_or_init(|| async {
        let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest());
        if let Some(region) = crate::config::s3_region() {
            loader = loader.region(aws_config::Region::new(region));
        }
        if let Some(endpoint) = crate::config::s3_endpoint() {
            loader = loader.endpoint_url(endpoint);
        }
        let shared = loader.load().await;
        let mut s3 = aws_sdk_s3::config::Builder::from(&shared);
        if crate::config::s3_endpoint().is_some() {
            // Real S3 addresses buckets as a subdomain; MinIO, LocalStack and the
            // mock server in the tests want the bucket in the path instead. An
            // endpoint override always means one of the latter.
            s3 = s3.force_path_style(true);
        }
        info!(
            target: "startup",
            bucket = crate::config::s3_bucket().unwrap_or_default(),
            "S3 storage backend initialised"
        );
        aws_sdk_s3::Client::from_conf(s3.build())
    })
    .await
}

/// Write `bytes` under `stored_path`. Whole-object write: every caller already
/// buffers the upload in memory to encrypt it, so there is nothing to stream.
pub async fn put(stored_path: &str, bytes: Vec<u8>) -> Result<()> {
    match crate::config::s3_bucket() {
        Some(bucket) => {
            let key = s3_key(stored_path)?;
            s3_client()
                .await
                .put_object()
                .bucket(&bucket)
                .key(&key)
                .body(bytes.into())
                .send()
                .await
                .map_err(|err| StorageError::Backend(format!("S3 put {key} failed: {err}")))?;
            Ok(())
        }
        None => {
            let path = local_path(stored_path)?;
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let mut file = tokio::fs::File::create(&path).await?;
            file.write_all(&bytes).await?;
            Ok(())
        }
    }
}

/// Read the object back. With S3 configured, a miss falls back to the local
/// disk so files written before the cutover keep serving during a migration.
pub async fn get(stored_path: &str) -> Result<Vec<u8>> {
    let Some(bucket) = crate::config::s3_bucket() else {
        return Ok(tokio::fs::read(local_path(stored_path)?).await?);
    };

    let key = s3_key(stored_path)?;
    let found = s3_client()
        .await
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await;

    match found {
        Ok(output) => {
            let data = output
                .body
                .collect()
                .await
                .map_err(|err| StorageError::Backend(format!("S3 read {key} failed: {err}")))?;
            Ok(data.into_bytes().to_vec())
        }
        Err(err) if is_no_such_key(&err) => {
            // Pre-migration file, or one uploaded while the bucket was
            // unconfigured. Serve it off the volume and say so once, so a
            // still-noisy log after `aws s3 sync` is a signal the copy missed
            // something.
            let path = local_path(stored_path)?;
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|_| StorageError::NotFound)?;
            info!(target: "http", key = %key, "served upload from disk fallback (not in S3)");
            Ok(bytes)
        }
        Err(err) => Err(StorageError::Backend(format!("S3 get {key} failed: {err}"))),
    }
}

/// Remove the object. Deleting what isn't there is success — callers treat
/// deletion as best-effort cleanup after the DB row is already gone.
pub async fn delete(stored_path: &str) -> Result<()> {
    if let Some(bucket) = crate::config::s3_bucket() {
        let key = s3_key(stored_path)?;
        s3_client()
            .await
            .delete_object()
            .bucket(&bucket)
            .key(&key)
            .send()
            .await
            .map_err(|err| StorageError::Backend(format!("S3 delete {key} failed: {err}")))?;
    }
    // Always clear the local copy too: during a migration the same logical file
    // can exist in both places, and a delete that left the disk copy behind
    // would resurrect it through the read fallback.
    match tokio::fs::remove_file(local_path(stored_path)?).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn is_no_such_key<E: std::fmt::Debug>(
    err: &aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::get_object::GetObjectError, E>,
) -> bool {
    matches!(
        err,
        aws_sdk_s3::error::SdkError::ServiceError(inner)
            if inner.err().is_no_such_key()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_every_historical_prefix_form() {
        // The three shapes that exist in the database today.
        assert_eq!(
            relative_key("./uploads/abc_file.png").unwrap(),
            "abc_file.png"
        );
        assert_eq!(relative_key("/uploads/abc").unwrap(), "abc");
        assert_eq!(relative_key("uploads/abc").unwrap(), "abc");
        // Avatars keep their subdirectory.
        assert_eq!(
            relative_key("./uploads/avatars/id.png").unwrap(),
            "avatars/id.png"
        );
    }

    #[test]
    fn rejects_traversal_and_empty_keys() {
        assert!(relative_key("./uploads/../../etc/passwd").is_err());
        assert!(relative_key("./uploads/").is_err());
        assert!(relative_key("   ").is_err());
    }

    #[test]
    fn stored_path_round_trips_through_relative_key() {
        let path = stored_path("uuid_name.pdf");
        assert_eq!(path, "./uploads/uuid_name.pdf");
        assert_eq!(relative_key(&path).unwrap(), "uuid_name.pdf");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn local_backend_round_trips_bytes() {
        // No S3_BUCKET → local disk. Written under ./uploads relative to the
        // crate's working directory, then cleaned up.
        unsafe { std::env::remove_var("S3_BUCKET") };
        let name = format!("storage-test-{}.bin", uuid::Uuid::new_v4());
        let path = stored_path(&name);

        put(&path, b"hello".to_vec())
            .await
            .unwrap_or_else(|e| panic!("put failed: {e}"));
        let read = get(&path)
            .await
            .unwrap_or_else(|e| panic!("get failed: {e}"));
        assert_eq!(read, b"hello");

        delete(&path)
            .await
            .unwrap_or_else(|e| panic!("delete failed: {e}"));
        assert!(matches!(get(&path).await, Err(StorageError::NotFound)));
        // Deleting again is not an error.
        delete(&path)
            .await
            .unwrap_or_else(|e| panic!("second delete failed: {e}"));
    }
}
