import { useEffect, useState } from "react";
import { getConnectedIntegrations } from "../api/integrations";
import type { IntegrationKey } from "./catalog";

// Fired after connecting or disconnecting a service so the sidebar's
// Integrations group updates without a reload.
export const INTEGRATIONS_CHANGED_EVENT = "rwayve:integrations-changed";

/**
 * The services this account has connected and enabled. Empty until the first
 * response lands, and on any failure — the sidebar lists what it can prove is
 * live, so a failed probe hides a row rather than inventing one.
 *
 * `enabled` gates the fetch on auth state, so passing `false` during logout
 * keeps it from firing a 401.
 */
export function useConnectedIntegrations(
  enabled: boolean = true
): IntegrationKey[] {
  const [connected, setConnected] = useState<IntegrationKey[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refresh = () => {
      getConnectedIntegrations()
        .then((res) => {
          if (!cancelled) setConnected(res.connected ?? []);
        })
        .catch(() => {
          // Keep the last known list on a transient failure; the next event or
          // remount retries.
        });
    };

    refresh();

    const onChanged = () => refresh();
    window.addEventListener(INTEGRATIONS_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(INTEGRATIONS_CHANGED_EVENT, onChanged);
    };
  }, [enabled]);

  return connected;
}
