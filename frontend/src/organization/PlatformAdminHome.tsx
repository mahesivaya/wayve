import AIChat from "../aichat/AIChat";
import "./admin-ui.css";
import "./platformAdmin.css";

// Platform admin home: the AI assistant. The sprint chart and the console
// cards with their stats live on the Analytics page (/platform/analytics).
export default function PlatformAdminHome() {
  return (
    <div className="platform-admin-home u-page-shell">
      <section className="platform-admin-panel u-panel platform-ai-panel">
        <div
          className="platform-ai-chat"
          style={{
            height: 560,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRadius: "var(--radius-md, 12px)",
          }}
        >
          <AIChat hideHeader />
        </div>
      </section>
    </div>
  );
}
