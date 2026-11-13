import AIChat from "../aichat/AIChat";
import "../home/home.css";

// Platform admin home: the AI assistant. The sprint chart and the console
// cards with their stats live on the Analytics page (/platform/analytics).
// Same surface as the plain Home: the chat fills the pane, so a split's second
// Home tab looks identical to this one.
export default function PlatformAdminHome() {
  return (
    <div className="home-authed-aichat">
      <AIChat hideHeader />
    </div>
  );
}
