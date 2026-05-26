import { useNavigate, useParams } from "react-router-dom";
import { isAppKey, type AppKey } from "./registry";
import AppPane from "./AppPane";
import SplitView from "./SplitView";

export default function Split() {
  const navigate = useNavigate();
  const { left, right } = useParams<{ left: string; right?: string }>();

  const leftKey: AppKey | null = isAppKey(left) ? left : null;
  const rightKey: AppKey | null = isAppKey(right) ? right : null;

  if (!leftKey) {
    return null;
  }

  function pickRight(key: AppKey) {
    if (key === leftKey) return;
    void navigate(`/split/${leftKey}/${key}`, { replace: true });
  }

  function pickLeft(key: AppKey) {
    if (key === rightKey) return;
    void navigate(`/split/${key}/${rightKey ?? ""}`, { replace: true });
  }

  function closeLeft() {
    if (rightKey) {
      void navigate(`/${rightKey}`);
    } else {
      void navigate("/home");
    }
  }

  function closeRight() {
    void navigate(`/${leftKey}`);
  }

  return (
    <SplitView
      left={
        <AppPane
          appKey={leftKey}
          side="left"
          onPick={pickLeft}
          onClose={closeLeft}
        />
      }
      right={
        <AppPane
          appKey={rightKey}
          side="right"
          onPick={pickRight}
          onClose={closeRight}
        />
      }
    />
  );
}
