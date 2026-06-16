import { type ReactNode } from "react";
import MarketingShell from "../marketing/MarketingShell";
import Layout from "../components/Layout";
import { useAuth } from "../auth/useAuth";
import "./docsShell.css";

type DocsShellProps = {
  children: ReactNode;
  /**
   * Optional breadcrumb title override. Accepted for call-site compatibility;
   * the shell renders the page body directly.
   */
  title?: string;
  /**
   * Accepted for call-site compatibility (the Developers page passes it). The
   * shell now always renders a single full-width content column.
   */
  single?: boolean;
};

/**
 * Persistent docs chrome: MarketingShell on the outside (brand + nav + footer)
 * for anonymous visitors, or the app Layout for signed-in users, wrapping a
 * single full-width content column.
 *
 * The shell wraps every /docs/* page (the hub, Swagger UI, services, quotas,
 * developers, markdown docs). Pages stay simple — they just render their body
 * content, the shell handles the surrounding chrome. The in-shell navigation
 * menu (search + category tree) was removed; docs are navigated via in-page
 * links and the global nav.
 */
export default function DocsShell({ children }: DocsShellProps) {
  const { user } = useAuth();

  // Authenticated users keep their normal app chrome (Header, app switcher,
  // profile/logout menu) when reading docs; anonymous visitors get
  // MarketingShell (brand + Login/Register). Both accept arbitrary children.
  const OuterShell = user ? Layout : MarketingShell;

  return (
    <OuterShell>
      <div className={`docs-shell${user ? " docs-shell--app" : ""}`}>
        <main className="docs-content">{children}</main>
      </div>
    </OuterShell>
  );
}
