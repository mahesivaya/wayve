// App-wide error boundary for the lazy route tree. Without this, a failed
// dynamic import (a stale chunk after a deploy, or an HMR-corrupted lazy
// boundary in dev) or any render throw propagates past <Suspense> with nothing
// to catch it — React unmounts the whole tree and the page goes silently
// blank. This catches those: chunk-load failures auto-reload once; anything
// else shows a visible "something went wrong / reload" panel instead of blank.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../api/errorLogs";

const RELOAD_FLAG = "route-chunk-reloaded";

// A failed dynamic import surfaces under a few different messages/names across
// browsers and bundlers — match them all so we only auto-reload for genuine
// chunk-load failures, not for ordinary render bugs.
function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? "";
  const message = (error as { message?: string }).message ?? "";
  return (
    name === "ChunkLoadError" ||
    /dynamically imported module|loading chunk|importing a module script failed|failed to fetch dynamically/i.test(
      message
    )
  );
}

type Props = { children: ReactNode };
type State = { failed: boolean };

export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidMount() {
    // We rendered fine — clear the one-shot guard so a future stale chunk can
    // reload again.
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      /* sessionStorage may be unavailable; ignore */
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkLoadError(error)) {
      let alreadyReloaded = false;
      try {
        alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === "1";
        sessionStorage.setItem(RELOAD_FLAG, "1");
      } catch {
        /* ignore */
      }
      // Auto-reload once to pick up the fresh bundle/chunk map. Guard against a
      // loop if the chunk is genuinely gone (then we fall through to the panel).
      if (!alreadyReloaded) {
        window.location.reload();
        return;
      }
    }
    // Surface non-chunk errors for diagnosis instead of swallowing them.
    console.error("RouteErrorBoundary caught:", error, info.componentStack);
    // React-caught render errors don't fire window.onerror, so the global
    // reporter (installErrorReporter) never sees them. Forward them here so
    // they still land in /api/error-logs and the platform dashboard.
    reportClientError({
      severity: "error",
      message: error.message || "render error",
      stack: error.stack,
      extra: { componentStack: info.componentStack },
    });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        style={{
          padding: 40,
          maxWidth: 520,
          margin: "80px auto",
          textAlign: "center",
        }}
      >
        <h2>Something went wrong loading this page.</h2>
        <p style={{ color: "#6b7280" }}>
          The page failed to load. Reloading usually fixes it.
        </p>
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.removeItem(RELOAD_FLAG);
            } catch {
              /* ignore */
            }
            window.location.reload();
          }}
          style={{ marginTop: 16, padding: "8px 18px", cursor: "pointer" }}
        >
          Reload
        </button>
      </div>
    );
  }
}
