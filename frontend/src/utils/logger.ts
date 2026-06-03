type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const isDev = (() => {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
})();

const minLevel: Level = "debug";

interface BufferEntry {
  ts: string;
  level: Level;
  scope?: string;
  args: unknown[];
}

// Ring buffer so devtools can inspect the last N log lines — useful when
// chasing a bug and you want to see what preceded the failure.
const BUFFER_LIMIT = 500;
const buffer: BufferEntry[] = [];

function pushBuffer(entry: BufferEntry) {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.shift();
}

function emit(level: Level, scope: string | undefined, args: unknown[]) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const ts = new Date().toISOString();
  pushBuffer({ ts, level, scope, args });

  const tag = scope ? `[${level.toUpperCase()} ${ts} ${scope}]` : `[${level.toUpperCase()} ${ts}]`;

  // Direct console.* calls (not an indirect `fn(...)`) so the production
  // build's drop-console minifier pass strips them — leaving only the ring
  // buffer in prod. Dev keeps full console output.
  switch (level) {
    case "error":
      console.error(tag, ...args);
      break;
    case "warn":
      console.warn(tag, ...args);
      break;
    case "debug":
      console.debug(tag, ...args);
      break;
    default:
      console.log(tag, ...args);
  }
}

interface Logger {
  debug: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** Named user/system event — info level, marked with "•". */
  event: (name: string, data?: unknown) => void;
  /** Times an async fn and logs label + duration. Re-throws any error. */
  time: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  scope: (name: string) => Logger;
}

function make(scope?: string): Logger {
  return {
    debug: (...args) => emit("debug", scope, args),
    log: (...args) => emit("info", scope, args),
    info: (...args) => emit("info", scope, args),
    warn: (...args) => emit("warn", scope, args),
    error: (...args) => emit("error", scope, args),
    event: (name, data) => emit("info", scope, data === undefined ? [`• ${name}`] : [`• ${name}`, data]),
    time: async (label, fn) => {
      const start = performance.now();
      try {
        const out = await fn();
        const ms = Math.round(performance.now() - start);
        emit("debug", scope, [`⏱ ${label} ok in ${ms}ms`]);
        return out;
      } catch (err) {
        const ms = Math.round(performance.now() - start);
        emit("warn", scope, [`⏱ ${label} failed in ${ms}ms`, err]);
        throw err;
      }
    },
    scope: (name) => make(scope ? `${scope}.${name}` : name),
  };
}

export const logger: Logger = make();

/** Snapshot of the most recent log entries. Newest last. */
export const getRecentLogs = (): BufferEntry[] => buffer.slice();

if (isDev && typeof window !== "undefined") {
  (window as unknown as { __log: { recent: () => BufferEntry[]; logger: Logger } }).__log = {
    recent: getRecentLogs,
    logger,
  };
}
