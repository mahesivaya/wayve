// Without this boundary a failed dynamic import (a stale chunk after a deploy)
// or any render throw propagates past <Suspense> uncaught, React unmounts the
// tree, and the page goes silently blank. Chunk-load failures auto-reload once;
// anything else shows a reload panel.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../api/errorLogs";

const RELOAD_FLAG = "route-chunk-reloaded";

// Browsers and bundlers report a failed dynamic import under several different
// names and messages. Matching them all keeps the auto-reload to genuine
// chunk-load failures rather than ordinary render bugs.
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
    // Rendering succeeded, so clear the one-shot guard and let a future stale
    // chunk reload again.
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
      // Reload once for the fresh chunk map. The guard prevents a reload loop
      // when the chunk is genuinely gone; that case falls through to the panel.
      if (!alreadyReloaded) {
        window.location.reload();
        return;
      }
    }
    console.error("RouteErrorBoundary caught:", error, info.componentStack);
    // React-caught render errors don't fire window.onerror, so the global
    // reporter never sees them. Forward them so they still reach /api/error-logs.
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
