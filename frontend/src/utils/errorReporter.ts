// Browser-side error reporting. Wires `window.onerror` and the
// `unhandledrejection` listener to forward every uncaught failure to
// the backend's /api/error-logs endpoint. Runs in BOTH dev and prod —
// the dashboard at /logs/app is the production observability
// surface for client-side faults the user actually experiences.
//
// Call once from main.tsx. Idempotent.

import { reportClientError } from "../api/errorLogs";

let installed = false;

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

export function installErrorReporter(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (ev) => {
    const { message, stack } = describe(ev.error ?? ev.message);
    reportClientError({
      severity: "error",
      message: message || "uncaught error",
      stack,
      extra: {
        file: ev.filename,
        line: ev.lineno,
        col: ev.colno,
      },
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const { message, stack } = describe(ev.reason);
    reportClientError({
      severity: "error",
      message: `unhandled rejection: ${message || "(no message)"}`,
      stack,
    });
  });
}
