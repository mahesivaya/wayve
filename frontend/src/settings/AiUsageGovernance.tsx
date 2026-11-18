// Owner-only AI usage dashboard, gated by `ai:manage`. The token breakdown
// itself lives in `AiUsagePanel`, which the AI provider page also embeds.

import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import AiUsagePanel from "./AiUsagePanel";
import "./aiProvider.css";

export default function AiUsageGovernance() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canManage = hasPermission(user, "ai:manage");
  // The platform owner gets the site-wide, per-tenant breakdown; an
  // organization's owner gets its own members.
  const isPlatform = user?.scope === "platform";

  if (!canManage) {
    return (
      <div className="ai-usage">
        <h1>AI Usage</h1>
        <p className="ai-error">
          Only the organization <strong>owner</strong> can view AI usage.
        </p>
        <button onClick={() => navigate("/home")}>Back to Home</button>
      </div>
    );
  }

  return (
    <div className="ai-usage">
      <header className="ai-settings-header">
        <h1>AI Token Usage</h1>
        <p>
          {isPlatform
            ? "Complete website usage across your whole platform — by scope, by team member, and by model."
            : "Token consumption for your AI provider, by member and by model."}
        </p>
        <button
          type="button"
          className="ai-link-btn"
          onClick={() => navigate("/settings/ai")}
        >
          ← Back to AI provider settings
        </button>
      </header>

      <AiUsagePanel showProvider />
    </div>
  );
}
