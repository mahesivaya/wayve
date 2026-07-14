import { type ReactNode } from "react";
import MarketingShell from "../marketing/MarketingShell";
import Layout from "../components/Layout";
import { useAuth } from "../auth/useAuth";
import "./docsShell.css";

type DocsShellProps = {
  children: ReactNode;
  /** Ignored; accepted only for call-site compatibility. */
  title?: string;
  /** Ignored; accepted only for call-site compatibility. */
  single?: boolean;
};

/** Chrome wrapping every /docs/* page. */
export default function DocsShell({ children }: DocsShellProps) {
  const { user } = useAuth();

  // Signed-in users keep their normal app chrome while reading docs; anonymous
  // visitors get the marketing chrome. Both accept arbitrary children.
  const OuterShell = user ? Layout : MarketingShell;

  return (
    <OuterShell>
      <div className={`docs-shell${user ? " docs-shell--app" : ""}`}>
        <main className="docs-content">{children}</main>
      </div>
    </OuterShell>
  );
}
