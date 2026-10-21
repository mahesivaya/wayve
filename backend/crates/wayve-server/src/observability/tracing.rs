use std::fs::{File, OpenOptions, create_dir_all, metadata, remove_file, rename};
use std::io::{self, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::{EnvFilter, Layer, fmt, layer::SubscriberExt, util::SubscriberInitExt};

use crate::config::RuntimeRole;

// Default filter for the stdout layer: everything at DEBUG except the chatty
// framework targets, which would otherwise bury the app's own logs. The full
// unfiltered stream still reaches the process's log file. Override with
// RWAYVE_LOG_STDOUT_FILTER, using RUST_LOG syntax.
const DEFAULT_STDOUT_FILTER: &str = "debug,hyper=warn,hyper_util=warn,h2=warn,\
rustls=warn,mio=warn,tokio=warn,reqwest=warn,sqlx=warn,want=warn,tower=warn,tonic=warn";

const TRACING_LOG_DIR: &str = "logs";

/// This process's log file. The API keeps `logs/tracing.log`, which the
/// tracing route tails; each worker gets a file of its own. The backend and
/// both workers share one logs volume, and each process rotates by its own
/// byte count, so a shared file was renamed out from under the others: they
/// kept appending to the archive, which then outgrew the size cap, and writes
/// landing in an archive as it was deleted were lost.
fn tracing_log_path(role: RuntimeRole) -> String {
    match role {
        RuntimeRole::Api | RuntimeRole::All => format!("{TRACING_LOG_DIR}/tracing.log"),
        RuntimeRole::EmailSyncWorker => format!("{TRACING_LOG_DIR}/tracing-email-sync-worker.log"),
        RuntimeRole::EmailBodyWorker => format!("{TRACING_LOG_DIR}/tracing-email-body-worker.log"),
    }
}

#[derive(Clone)]
struct SizeRotatingFileWriter {
    state: Arc<Mutex<SizeRotatingState>>,
}

struct SizeRotatingState {
    path: String,
    file: File,
    bytes_written: u64,
    max_bytes: u64,
    max_archives: usize,
}

struct SizeRotatingGuard<'a> {
    state: MutexGuard<'a, SizeRotatingState>,
}

impl SizeRotatingFileWriter {
    fn new(path: String) -> io::Result<Self> {
        create_dir_all(TRACING_LOG_DIR)?;
        let file = open_tracing_file(&path)?;
        let bytes_written = metadata(&path).map(|meta| meta.len()).unwrap_or(0);

        Ok(Self {
            state: Arc::new(Mutex::new(SizeRotatingState {
                path,
                file,
                bytes_written,
                max_bytes: tracing_log_max_bytes(),
                max_archives: tracing_log_max_archives(),
            })),
        })
    }

    fn fallback() -> io::Result<Self> {
        let (path, file) = tempfile_file()?;
        Ok(Self {
            state: Arc::new(Mutex::new(SizeRotatingState {
                path,
                file,
                bytes_written: 0,
                max_bytes: tracing_log_max_bytes(),
                max_archives: tracing_log_max_archives(),
            })),
        })
    }
}

impl<'a> MakeWriter<'a> for SizeRotatingFileWriter {
    type Writer = SizeRotatingGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        // Recover from a poisoned mutex rather than panicking: a poisoned
        // tracing writer must not bring down the whole process.
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        SizeRotatingGuard { state }
    }
}

impl Write for SizeRotatingGuard<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.state.bytes_written > 0
            && self.state.bytes_written + buf.len() as u64 > self.state.max_bytes
        {
            self.state.rotate()?;
        }

        let written = self.state.file.write(buf)?;
        self.state.bytes_written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.state.file.flush()
    }
}

impl SizeRotatingState {
    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        rotate_tracing_files(&self.path, self.max_archives)?;
        self.file = open_tracing_file(&self.path)?;
        self.bytes_written = 0;
        Ok(())
    }
}

fn open_tracing_file(path: &str) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

fn rotate_tracing_files(path: &str, max_archives: usize) -> io::Result<()> {
    if max_archives == 0 {
        remove_if_exists(path)?;
        return Ok(());
    }

    remove_if_exists(&archive_path(path, max_archives))?;

    for index in (1..max_archives).rev() {
        let from = archive_path(path, index);
        let to = archive_path(path, index + 1);
        if metadata(&from).is_ok() {
            rename(from, to)?;
        }
    }

    if metadata(path).is_ok() {
        rename(path, archive_path(path, 1))?;
    }

    Ok(())
}

fn remove_if_exists(path: &str) -> io::Result<()> {
    match remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn archive_path(path: &str, index: usize) -> String {
    format!("{path}.{index}")
}

fn tracing_log_max_bytes() -> u64 {
    crate::config::tracing_log_max_bytes()
}

fn tracing_log_max_archives() -> usize {
    crate::config::tracing_log_max_archives()
}

fn tempfile_file() -> io::Result<(String, File)> {
    let path = std::env::temp_dir()
        .join(format!(
            "rwayve-tracing-fallback-{}.log",
            std::process::id()
        ))
        .to_string_lossy()
        .into_owned();
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((path, file))
}

pub fn init_tracing() {
    // One active tracing file per process, rotated at 30MB by default. Archives
    // are numbered newest-to-oldest: tracing.log.1, tracing.log.2, and so on.
    let path = tracing_log_path(RuntimeRole::from_env());
    let file_writer = SizeRotatingFileWriter::new(path.clone()).or_else(|e| {
        eprintln!("tracing: failed to open {path}: {e}");
        SizeRotatingFileWriter::fallback()
    });

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        concat!(
            "info,",
            "actix_web=info,",
            "sqlx=warn,",
            "hyper=warn,",
            "h2=warn,",
            "tokio=warn,",
            "reqwest=warn"
        )
        .into()
    });

    // The full JSON event stream always lands in logs/tracing.log. A second,
    // compact stdout layer additionally shows the live stream in `docker logs`
    // and `cargo run` terminals. It is on by default in development
    // (RWAYVE_ENV=development) and forced on or off with RWAYVE_LOG_STDOUT.
    let stdout_enabled = std::env::var("RWAYVE_LOG_STDOUT")
        .ok()
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or_else(|| {
            std::env::var("RWAYVE_ENV")
                .map(|env| env.eq_ignore_ascii_case("development"))
                .unwrap_or(false)
        });
    let stdout_layer = stdout_enabled.then(|| {
        let stdout_filter = EnvFilter::new(
            std::env::var("RWAYVE_LOG_STDOUT_FILTER")
                .unwrap_or_else(|_| DEFAULT_STDOUT_FILTER.to_string()),
        );
        fmt::layer()
            .with_writer(std::io::stdout)
            .with_ansi(true)
            .with_target(true)
            .with_line_number(true)
            .with_span_events(FmtSpan::NONE)
            .compact()
            .with_filter(stdout_filter)
    });

    // The stderr fallback fires only when the log file genuinely cannot be
    // opened, such as a full disk. Loud terminal output is wanted there so the
    // failure is not silent.
    match file_writer {
        Ok(writer) => {
            let file_layer = fmt::layer()
                .json()
                .with_writer(writer)
                .with_ansi(false)
                .with_current_span(true)
                .with_span_list(true)
                .with_target(true)
                .with_thread_ids(true)
                .with_thread_names(true)
                .with_file(true)
                .with_line_number(true)
                .with_span_events(FmtSpan::CLOSE);
            tracing_subscriber::registry()
                .with(env_filter)
                .with(file_layer)
                .with(stdout_layer)
                .init();
        }
        Err(e) => {
            eprintln!("tracing: file logging disabled ({e}) — falling back to stderr");
            let stderr_layer = fmt::layer()
                .with_target(false)
                .with_ansi(false)
                .with_writer(std::io::stderr)
                .compact();
            tracing_subscriber::registry()
                .with(env_filter)
                .with(stderr_layer)
                .init();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::read_to_string;

    #[test]
    fn each_process_writes_its_own_file() {
        assert_eq!(tracing_log_path(RuntimeRole::Api), "logs/tracing.log");
        assert_eq!(tracing_log_path(RuntimeRole::All), "logs/tracing.log");
        assert_eq!(
            tracing_log_path(RuntimeRole::EmailSyncWorker),
            "logs/tracing-email-sync-worker.log"
        );
        assert_eq!(
            tracing_log_path(RuntimeRole::EmailBodyWorker),
            "logs/tracing-email-body-worker.log"
        );
    }

    #[test]
    fn rotation_shifts_only_this_files_archives() {
        let dir = std::env::temp_dir().join(format!("rwayve-rotate-{}", std::process::id()));
        create_dir_all(&dir).unwrap_or_else(|e| panic!("temp dir: {e}"));
        let mine = dir.join("tracing.log").to_string_lossy().into_owned();
        let other = dir
            .join("tracing-email-sync-worker.log")
            .to_string_lossy()
            .into_owned();
        let write = |path: &str, text: &str| {
            std::fs::write(path, text).unwrap_or_else(|e| panic!("write {path}: {e}"))
        };
        let read = |path: &str| read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        write(&mine, "current");
        write(&archive_path(&mine, 1), "older");
        write(&other, "worker");

        rotate_tracing_files(&mine, 2).unwrap_or_else(|e| panic!("rotate: {e}"));

        assert!(metadata(&mine).is_err(), "the active file moves to .1");
        assert_eq!(read(&archive_path(&mine, 1)), "current");
        assert_eq!(read(&archive_path(&mine, 2)), "older");
        assert_eq!(
            read(&other),
            "worker",
            "another process's file is untouched"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
