// `#[instrument]` records every argument of the function it wraps unless the
// argument is skipped, and `HttpRequest`'s Debug output includes all headers:
// the Authorization bearer token, X-API-KEY and cookies. A handler that takes
// the request without `skip(req)` (or `skip_all`) therefore writes credentials
// into tracing.log on every call. This guard scans the crate's source so a new
// handler can't reintroduce that.
#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // The integration tests construct requests on purpose.
                if path.file_name().is_some_and(|n| n == "tests") {
                    continue;
                }
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// Names given to the `skip(...)` list of an `#[instrument(...)]` attribute.
    fn skipped_args(attr: &str) -> Vec<String> {
        let Some(start) = attr.find("skip(") else {
            return Vec::new();
        };
        let rest = &attr[start + "skip(".len()..];
        let end = rest.find(')').unwrap_or(rest.len());
        rest[..end]
            .split(',')
            .map(|s| s.trim().to_string())
            .collect()
    }

    /// The parameter name bound to an `HttpRequest`, if the signature has one.
    fn request_param(signature: &str) -> Option<String> {
        let at = signature.find("HttpRequest")?;
        let before = signature[..at].trim_end().trim_end_matches('&').trim_end();
        let before = before.strip_suffix(':')?.trim_end();
        let name: String = before
            .chars()
            .rev()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        (!name.is_empty()).then_some(name)
    }

    #[test]
    fn instrumented_handlers_never_record_the_request() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);

        let mut offenders = Vec::new();
        for file in &files {
            let text = std::fs::read_to_string(file)
                .unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if !line.trim_start().starts_with("#[instrument") {
                    continue;
                }
                // The attribute may span lines; collect it up to the `fn`.
                let mut attr = String::new();
                let mut j = i;
                while j < lines.len() && !lines[j].contains("fn ") {
                    attr.push_str(lines[j]);
                    j += 1;
                }
                // The signature runs up to the body's opening brace.
                let signature: String = lines[j.min(lines.len())..]
                    .iter()
                    .take(12)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(" ");
                let signature = signature.split('{').next().unwrap_or("");
                let Some(req) = request_param(signature) else {
                    continue;
                };
                if attr.contains("skip_all") || skipped_args(&attr).contains(&req) {
                    continue;
                }
                offenders.push(format!(
                    "{}:{} records `{req}` (add it to skip(...))",
                    file.strip_prefix(&src).unwrap_or(file).display(),
                    i + 1
                ));
            }
        }
        assert!(
            offenders.is_empty(),
            "instrumented functions log the HttpRequest (headers, incl. auth tokens):\n{}",
            offenders.join("\n")
        );
    }
}
