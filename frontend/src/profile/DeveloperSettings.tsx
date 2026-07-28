import { useNavigate } from "react-router-dom";

import SettingsShell from "./SettingsShell";
import { useAuth } from "../auth/useAuth";
import { canAccessApiKeyAdmin } from "../auth/permissions";
import {
  DocsIcon,
  ApiRefIcon,
  LibrariesIcon,
  ApiKeysIcon,
} from "../icons";

// The developer references — docs, API, SDK, keys — as one settings page.
// They used to be a collapsible group in the main sidebar, which put five rows
// of reference material in the same rail as the apps people work in all day;
// they are reached rarely and belong with the other account-level settings.
//
// Visibility rules are carried over verbatim from that sidebar group: the page
// is for non-personal accounts, Docs is platform-scope only, and API Keys keeps
// its permission gate. `SettingsSideNav` hides the entry on the same predicate
// and the route in App.tsx bounces anyone who reaches it by URL.
export default function DeveloperSettings() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const entries = [
    {
      path: "/docs",
      label: "Docs",
      description: "Guides and reference for building on the platform.",
      action: "Open docs",
      icon: <DocsIcon size={16} />,
      visible: user?.scope === "platform",
    },
    {
      path: "/docs/api",
      label: "API reference",
      description: "Every endpoint, its parameters and responses.",
      action: "Open reference",
      icon: <ApiRefIcon size={16} />,
      visible: true,
    },
    {
      // The sidebar listed Libraries and SDK as two rows pointing at this one
      // route (only SDK was ever marked active). Two rows to the same page read
      // as a bug in a list this short, so they are one entry here.
      path: "/docs/developers",
      label: "Libraries & SDK",
      description: "Client libraries and the SDK for your language.",
      action: "Open libraries",
      icon: <LibrariesIcon size={16} />,
      visible: true,
    },
    {
      path: "/api-keys",
      label: "API keys",
      description: "Issue and revoke scoped keys for service access.",
      action: "Manage keys",
      icon: <ApiKeysIcon size={16} />,
      visible: canAccessApiKeyAdmin(user),
    },
  ].filter((entry) => entry.visible);

  return (
    <SettingsShell title="Developers">
      <section className="settings-card">
        <h2 className="settings-card-title">Developer resources</h2>
        <div className="settings-rows">
          {entries.map((entry) => (
            <div className="settings-usage-row" key={entry.label}>
              <span data-tooltip={entry.description}>
                <span className="settings-account-link-icon">{entry.icon}</span>{" "}
                {entry.label}
              </span>
              <button
                type="button"
                className="settings-billing-link"
                onClick={() => void navigate(entry.path)}
              >
                {entry.action}
              </button>
            </div>
          ))}
        </div>
      </section>
    </SettingsShell>
  );
}
