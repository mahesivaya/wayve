//! File logger backing `info!/warn!/error!` while `tracing-subscriber` is
//! disabled.
//!
//! The `tracing/log-always` feature forwards every `tracing` call, including
//! its `target = "..."` and structured fields, to the `log` facade. `DevLogger`
//! is registered as that facade's implementation and writes formatted lines to
//! `backend/logs/dev.log` and stderr, e.g.
//!
//! ```text
//! 2026-05-07 12:31:22.481 INFO  [auth] User registered: demo@gmail.com
//! ```

use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::sync::Mutex;

use chrono::Local;
use log::{Level, LevelFilter, Log, Metadata, Record};
use once_cell::sync::OnceCell;

static FILE: OnceCell<Mutex<std::fs::File>> = OnceCell::new();

struct DevLogger;

impl Log for DevLogger {
    fn enabled(&self, meta: &Metadata) -> bool {
        // Skip noisy framework internals at INFO; let WARN/ERROR through. App
        // code sets target = "auth" | "ws" | "worker" | "db" to stay readable.
        let target = meta.target();
        if meta.level() >= Level::Info
            && (target.starts_with("hyper")
                || target.starts_with("h2")
                || target.starts_with("rustls")
                || target.starts_with("mio")
                || target.starts_with("tokio")
                || target.starts_with("sqlx::query"))
        {
            return meta.level() <= Level::Warn;
        }
        meta.level() <= Level::Info
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let level = match record.level() {
            Level::Error => "ERROR",
            Level::Warn => "WARN ",
            Level::Info => "INFO ",
            Level::Debug => "DEBUG",
            Level::Trace => "TRACE",
        };

        let target = record.target();
        let line = if target.is_empty() || target == "rwayve" {
            format!(
                "{} {} {}\n",
                Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                level,
                record.args()
            )
        } else {
            format!(
                "{} {} [{}] {}\n",
                Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                level,
                target,
                record.args()
            )
        };

        // Mirror to stderr so devs see logs without tailing the file.
        eprint!("{line}");
        if let Some(m) = FILE.get()
            && let Ok(mut f) = m.lock()
        {
            let _ = f.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {
        if let Some(m) = FILE.get()
            && let Ok(mut f) = m.lock()
        {
            let _ = f.flush();
        }
    }
}

/// Open `logs/dev.log` and register `DevLogger` as the global `log`
/// implementation. Safe to call once on startup.
pub fn init_devlog() {
    if FILE.get().is_some() {
        return;
    }
    let _ = create_dir_all("logs");
    match OpenOptions::new()
        .create(true)
        .append(true)
        .open("logs/dev.log")
    {
        Ok(f) => {
            let _ = FILE.set(Mutex::new(f));
        }
        Err(e) => {
            eprintln!("devlog: failed to open logs/dev.log: {e}");
        }
    }

    static LOGGER: DevLogger = DevLogger;
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}
