import { apiFetchJson } from "./client";
import type { IntegrationKey } from "../integrations/catalog";

// One call answers "what is connected" for every service, instead of asking
// each integration's own /connection endpoint (six-plus requests, several of
// which 403 for accounts that aren't eligible). Cached briefly because the
// sidebar asks on every mount.
export const getConnectedIntegrations = async () =>
  apiFetchJson<{ connected: IntegrationKey[] }>("/api/integrations/status", {
    cacheTtlMs: 30_000,
  });
