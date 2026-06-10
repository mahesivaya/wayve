import { Link, useLocation } from "react-router-dom";
import { SPLIT_APPS, type AppKey } from "./LayoutConfig";

interface AppNavProps {
  splitTarget: "left" | "middle" | "right";
  middleView: AppKey | null;
  rightView: AppKey | null;
  onSetMiddleView: (app: AppKey) => void;
  onSetRightView: (app: AppKey) => void;
}

export default function AppNav({
  splitTarget,
  middleView,
  rightView,
  onSetMiddleView,
  onSetRightView,
}: AppNavProps) {
  const location = useLocation();

  const navItem = (path: string, app: AppKey, label: string) => {
    const isLeftActive = location.pathname === path;
    const isSplitActive = middleView === app || rightView === app;

    return (
      <Link
        to={path}
        key={app}
        className={[
          isLeftActive ? "active" : "",
          isSplitActive ? "active-split" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={(e) => {
          if (splitTarget === "middle") {
            e.preventDefault();
            onSetMiddleView(app);
          } else if (splitTarget === "right") {
            e.preventDefault();
            onSetRightView(app);
          }
        }}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="nav">
      {SPLIT_APPS.map((app) => navItem(app.path, app.key, app.label))}
    </div>
  );
}
