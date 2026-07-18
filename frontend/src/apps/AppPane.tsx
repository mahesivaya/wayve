import { Suspense } from "react";
import { APP_REGISTRY, type AppKey } from "./registry";
import AppPicker from "./AppPicker";
import "./apps.css";

type Props = {
  appKey: AppKey | null;
  side: "left" | "right";
  onPick: (key: AppKey) => void;
  onClose: () => void;
};

export default function AppPane({ appKey, side, onPick, onClose }: Props) {
  const app = appKey ? APP_REGISTRY[appKey] : null;

  return (
    <div className="app-pane" data-side={side}>
      <div className="app-pane-header">
        <div className="app-pane-title">
          {app ? (
            <>
              <span className="app-pane-icon">{app.icon}</span>
              <span>{app.label}</span>
            </>
          ) : (
            <span className="app-pane-empty">Empty pane</span>
          )}
        </div>
        <button
          className="app-pane-close"
          onClick={onClose}
          data-tooltip="Close pane"
          aria-label="Close pane"
        >
          ×
        </button>
      </div>

      <div className="app-pane-body">
        {app ? (
          <Suspense fallback={<div className="app-pane-loading">Loading…</div>}>
            <app.Component />
          </Suspense>
        ) : (
          <AppPicker onPick={onPick} title="Open app in this pane" />
        )}
      </div>
    </div>
  );
}
