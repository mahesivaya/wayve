import { useState, type ReactNode } from "react";

// Gmail-style compose window: docked to the bottom-right of the Emails page
// with no backdrop, so the list and open emails behind it stay usable while
// writing. It can be minimized to its title bar (the form stays mounted, so
// nothing typed is lost) or expanded to fill the page.
export default function ComposeWindow({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const toggleMinimized = () => {
    setMinimized((m) => !m);
    setMaximized(false);
  };

  return (
    <section
      className={[
        "compose-window",
        minimized ? "is-minimized" : "",
        maximized ? "is-maximized" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      // Escape closes it only when pressed inside the window.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header
        className="compose-window-header"
        // Like Gmail, a click on the minimized bar opens it back up.
        onClick={minimized ? toggleMinimized : undefined}
      >
        <h3 className="compose-window-title">{title}</h3>
        <div
          className="compose-window-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="compose-window-btn"
            onClick={toggleMinimized}
            aria-label={minimized ? "Restore" : "Minimize"}
            title={minimized ? "Restore" : "Minimize"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {minimized ? <path d="M6 15l6-6 6 6" /> : <path d="M6 18h12" />}
            </svg>
          </button>
          <button
            type="button"
            className="compose-window-btn"
            onClick={() => {
              setMaximized((m) => !m);
              setMinimized(false);
            }}
            aria-label={maximized ? "Exit full screen" : "Full screen"}
            title={maximized ? "Exit full screen" : "Full screen"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {maximized ? (
                <path d="M10 4v6H4 M14 20v-6h6 M4 10l6-6 M20 14l-6 6" />
              ) : (
                <path d="M14 4h6v6 M10 20H4v-6 M20 4l-7 7 M4 20l7-7" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="compose-window-btn"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12 M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>
      {/* Hidden, not unmounted, while minimized: the draft survives. */}
      <div className="compose-window-body" hidden={minimized}>
        {children}
      </div>
    </section>
  );
}
