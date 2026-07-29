import { apiFetchJson } from "./client";

// The platform's own API catalogue, read from the OpenAPI document the backend
// serves at /api/openapi.json (see backend openapi/handler.rs). That document is
// the one place every published endpoint is declared, so the catalogue never
// drifts from what the API actually offers — nothing here is hand-maintained.

// Only the fields the catalogue renders; the spec carries far more (schemas,
// responses, parameters) that a list view has no use for.
type SpecOperation = {
  tags?: string[];
  operationId?: string;
  summary?: string;
  /** Custom extension: the API-key scope this endpoint requires. */
  "x-scope"?: string;
};

type SpecDocument = {
  info?: { title?: string; version?: string };
  tags?: { name: string; description?: string }[];
  paths?: Record<string, Record<string, SpecOperation | unknown>>;
};

export type ApiEndpoint = {
  /** Upper-case verb, e.g. "GET". */
  method: string;
  path: string;
  /** The group the endpoint belongs to ("Emails", "Chat", …). */
  tag: string;
  operationId: string;
  summary: string;
  /** Required API-key scope, or "" when the spec doesn't declare one. */
  scope: string;
};

export type ApiCatalogue = {
  title: string;
  version: string;
  /** Tag name → description, for the group headings. */
  groups: Record<string, string>;
  endpoints: ApiEndpoint[];
};

// Keys that appear alongside the verbs in a path item but are not operations.
const NON_METHOD_KEYS = new Set([
  "parameters",
  "summary",
  "description",
  "servers",
  "$ref",
]);

export async function getApiCatalogue(): Promise<ApiCatalogue> {
  const spec = await apiFetchJson<SpecDocument>("/api/openapi.json");

  const endpoints: ApiEndpoint[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (NON_METHOD_KEYS.has(method)) continue;
      const op = operation as SpecOperation;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        tag: op.tags?.[0] ?? "Other",
        operationId: op.operationId ?? "",
        summary: op.summary ?? "",
        scope: op["x-scope"] ?? "",
      });
    }
  }

  // Grouped by tag, then by path, so the list reads in the same order the API
  // reference does rather than in JSON-object order.
  endpoints.sort(
    (a, b) =>
      a.tag.localeCompare(b.tag) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method)
  );

  const groups: Record<string, string> = {};
  for (const tag of spec.tags ?? []) {
    groups[tag.name] = tag.description ?? "";
  }

  return {
    title: spec.info?.title ?? "API",
    version: spec.info?.version ?? "",
    groups,
    endpoints,
  };
}
