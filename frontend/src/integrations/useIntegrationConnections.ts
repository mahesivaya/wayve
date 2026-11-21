import { useCallback, useEffect, useState } from "react";
import { getJiraConnection } from "../api/jira";
import { getGithubAppStatus, getGithubConnection } from "../api/github";
import { getGitlabConnection } from "../api/gitlab";
import { getSlackConnection } from "../api/slack";
import { getFigmaConnection } from "../api/figma";
import { getMcpConnections } from "../api/mcp";
import { getAccounts } from "../api/email";
import { type EmailAccount } from "../emails/types";
import {
  canManageMcp,
  isEnterpriseViewer,
  type IntegrationKey,
  type IntegrationViewer,
} from "./catalog";

export type IntegrationConnections = Record<IntegrationKey, boolean>;

const NONE: IntegrationConnections = {
  gmail: false,
  jira: false,
  github: false,
  slack: false,
  gitlab: false,
  figma: false,
  mcp: false,
};

// One instance tells the others (the Integrations page tells the settings
// menu) when a service connects or disconnects.
const CHANGED = "rwayve:integration-connection";
type Change = { key: IntegrationKey; connected: boolean };

/**
 * Which services this account has connected. One probe per service, each
 * best-effort: an error just leaves that service unconnected. Shared by the
 * Integrations page and the settings menu, so both agree on what is connected.
 */
export function useIntegrationConnections(viewer: IntegrationViewer) {
  const [connected, setState] = useState<IntegrationConnections>(NONE);
  const signedIn = Boolean(viewer);
  // Slack is probed only for enterprise orgs, and MCP only for those who can
  // manage it; anyone else would get a 403.
  const probeSlack = isEnterpriseViewer(viewer);
  const probeMcp = canManageMcp(viewer);
  // An organization connects GitHub once for everyone, through the Hadal
  // GitHub App; everyone else connects their own account.
  const githubByApp = viewer?.scope === "organization";

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    const probe = (key: IntegrationKey, check: Promise<boolean>) =>
      void check
        .then((value) => {
          if (!cancelled) setState((prev) => ({ ...prev, [key]: value }));
        })
        .catch(() => {});

    probe(
      "jira",
      getJiraConnection().then((s) => s.connected)
    );
    probe(
      "github",
      (githubByApp ? getGithubAppStatus() : getGithubConnection()).then(
        (s) => s.connected
      )
    );
    probe(
      "gitlab",
      getGitlabConnection().then((s) => s.connected)
    );
    // Per-user, so every account probes it.
    probe(
      "figma",
      getFigmaConnection().then((s) => s.connected)
    );
    // The accounts summary doesn't expose the provider, so "connected" here
    // just means the user owns at least one mailbox.
    probe(
      "gmail",
      getAccounts<EmailAccount>().then((list) =>
        list.some((a) => a.is_owner !== false)
      )
    );
    if (probeSlack) {
      probe(
        "slack",
        getSlackConnection().then((s) => s.connected)
      );
    }
    if (probeMcp) {
      probe(
        "mcp",
        getMcpConnections().then((list) => list.some((c) => c.enabled))
      );
    }
    return () => {
      cancelled = true;
    };
  }, [signedIn, probeSlack, probeMcp, githubByApp]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const change = (event as CustomEvent<Change>).detail;
      if (!change) return;
      setState((prev) =>
        prev[change.key] === change.connected
          ? prev
          : { ...prev, [change.key]: change.connected }
      );
    };
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, []);

  /** Record a change made here (a panel connected or disconnected a service). */
  const setConnected = useCallback((key: IntegrationKey, value: boolean) => {
    window.dispatchEvent(
      new CustomEvent<Change>(CHANGED, { detail: { key, connected: value } })
    );
  }, []);

  return { connected, setConnected };
}
