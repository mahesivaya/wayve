use std::fs::{File, OpenOptions, create_dir_all, metadata, remove_file, rename};
use std::io::{self, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

const TRACING_LOG_DIR: &str = "logs";
const TRACING_LOG_PATH: &str = "logs/tracing.log";

#[derive(Clone)]
struct SizeRotatingFileWriter {
    state: Arc<Mutex<SizeRotatingState>>,
}

struct SizeRotatingState {
    file: File,
    bytes_written: u64,
    max_bytes: u64,
    max_archives: usize,
}

struct SizeRotatingGuard<'a> {
    state: MutexGuard<'a, SizeRotatingState>,
}

impl SizeRotatingFileWriter {
    fn new() -> io::Result<Self> {
        create_dir_all(TRACING_LOG_DIR)?;
        let file = open_tracing_file()?;
        let bytes_written = metadata(TRACING_LOG_PATH)
            .map(|meta| meta.len())
            .unwrap_or(0);

        Ok(Self {
            state: Arc::new(Mutex::new(SizeRotatingState {
                file,
                bytes_written,
                max_bytes: tracing_log_max_bytes(),
                max_archives: tracing_log_max_archives(),
            })),
        })
    }

    fn fallback() -> io::Result<Self> {
        let file = tempfile_file()?;
        Ok(Self {
            state: Arc::new(Mutex::new(SizeRotatingState {
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
        // Recover the guard if the mutex was poisoned instead of panicking —
        // a poisoned tracing writer must not bring down the whole process.
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
        rotate_tracing_files(self.max_archives)?;
        self.file = open_tracing_file()?;
        self.bytes_written = 0;
        Ok(())
    }
}

fn open_tracing_file() -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(TRACING_LOG_PATH)
}

fn rotate_tracing_files(max_archives: usize) -> io::Result<()> {
    if max_archives == 0 {
        remove_if_exists(TRACING_LOG_PATH)?;
        return Ok(());
    }

    remove_if_exists(&archive_path(max_archives))?;

    for index in (1..max_archives).rev() {
        let from = archive_path(index);
        let to = archive_path(index + 1);
        if metadata(&from).is_ok() {
            rename(from, to)?;
        }
    }

    if metadata(TRACING_LOG_PATH).is_ok() {
        rename(TRACING_LOG_PATH, archive_path(1))?;
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

fn archive_path(index: usize) -> String {
    format!("{TRACING_LOG_PATH}.{index}")
}

fn tracing_log_max_bytes() -> u64 {
    crate::config::tracing_log_max_bytes()
}

fn tracing_log_max_archives() -> usize {
    crate::config::tracing_log_max_archives()
}

fn tempfile_file() -> io::Result<File> {
    let path = std::env::temp_dir().join(format!(
        "rwayve-tracing-fallback-{}.log",
        std::process::id()
    ));
    OpenOptions::new().create(true).append(true).open(path)
}

pub fn init_tracing() {
    // Keep one active tracing file and rotate it at 30MB by default. Archives
    // are numbered newest-to-oldest: tracing.log.1, tracing.log.2, ...
    let file_writer = SizeRotatingFileWriter::new().or_else(|e| {
        eprintln!("tracing: failed to open {TRACING_LOG_PATH}: {e}");
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

    // ✅ Console logs
    let stdout_layer = fmt::layer()
        .with_target(false)
        .with_ansi(false) // 🔥 removes weird terminal escape codes
        .compact();

    // ✅ File logs — disabled gracefully if no writer could be opened.
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
                .with(stdout_layer)
                .with(file_layer)
                .init();
        }
        Err(e) => {
            eprintln!("tracing: file logging disabled ({e})");
            tracing_subscriber::registry()
                .with(env_filter)
                .with(stdout_layer)
                .init();
        }
    }
}
