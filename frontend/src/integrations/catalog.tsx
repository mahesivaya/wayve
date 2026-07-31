// The integration catalog — one list of what Fluxze can connect to, shared by
// the Integrations page (which adds descriptions, connection state, and the
// panels) and the sidebar's Integrations group (which just links into it).
//
// It lives here rather than inside Integrations.tsx so the two can't drift: a
// new service is added once and shows up in both places, with the same name,
// icon, order, and visibility rule.
import type { ReactNode } from "react";
import { BrandIcon } from "./BrandIcon";
import { hasPermission } from "../auth/permissions";

export type IntegrationKey =
  | "gmail"
  | "jira"
  | "github"
  | "slack"
  | "gitlab"
  | "figma"
  | "mcp";

// The slice of the signed-in user these rules read. Kept structural so both
// call sites can pass their own user object.
export type IntegrationViewer =
  | {
      scope?: string | null;
      permissions?: string[] | null;
      current_plan?: { tier?: string | null } | null;
    }
  | null
  | undefined;

export type IntegrationDef = {
  key: IntegrationKey;
  name: string;
  icon: ReactNode;
  /** Omitted → visible to everyone signed in. */
  visible?: (viewer: IntegrationViewer) => boolean;
};

export const isEnterpriseViewer = (viewer: IntegrationViewer): boolean =>
  viewer?.current_plan?.tier === "enterprise";

// UI visibility only; the backend enforces the same tier/scope gate.
export const canManageMcp = (viewer: IntegrationViewer): boolean =>
  hasPermission(viewer, "mcp:manage") &&
  (isEnterpriseViewer(viewer) || viewer?.scope === "platform");

// Slack carries no `visible` on purpose: it stays listed on every plan (the
// page badges it "Enterprise" and leaves the tile inert), because hiding it
// answered "can I connect Slack?" with silence.
export const INTEGRATIONS: IntegrationDef[] = [
  {
    key: "gmail",
    name: "Gmail",
    icon: <BrandIcon name="gmail" />,
    // Mirrors the backend gate `require_external_mailbox_actor`: any signed-in
    // account may connect its own mailbox, whatever its scope.
    visible: (viewer) => Boolean(viewer),
  },
  { key: "jira", name: "Jira", icon: <BrandIcon name="jira" /> },
  { key: "github", name: "GitHub", icon: <BrandIcon name="github" /> },
  { key: "slack", name: "Slack", icon: <BrandIcon name="slack" /> },
  { key: "gitlab", name: "GitLab", icon: <BrandIcon name="gitlab" /> },
  { key: "figma", name: "Figma", icon: <BrandIcon name="figma" /> },
  {
    key: "mcp",
    name: "Connect MCP",
    icon: <span aria-hidden="true">🔌</span>,
    visible: canManageMcp,
  },
];

/** The catalog minus the services this account can't use at all. */
export function visibleIntegrations(
  viewer: IntegrationViewer
): IntegrationDef[] {
  return INTEGRATIONS.filter((i) => i.visible?.(viewer) ?? true);
}
