import { apiFetch, apiFetchJson } from "./client";

// A connected MCP server (enterprise org / platform scope). The auth token is
// never returned — only its presence is implied by a successful validation.
export type McpConnection = {
  id: number;
  label: string;
  server_url: string;
  enabled: boolean;
  server_name: string | null;
  last_tool_count: number | null;
  last_validated_at: string | null;
};

export const getMcpConnections = async () =>
  apiFetchJson<McpConnection[]>("/api/integrations/mcp/connections");

export const addMcpConnection = async (payload: {
  label: string;
  server_url: string;
  auth_token?: string;
  auth_type?: "bearer" | "none";
}) =>
  apiFetchJson<McpConnection>("/api/integrations/mcp/connections", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const updateMcpConnection = async (
  id: number,
  payload: {
    label?: string;
    server_url?: string;
    auth_token?: string;
    enabled?: boolean;
  }
) =>
  apiFetchJson<McpConnection>(`/api/integrations/mcp/connections/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const deleteMcpConnection = async (id: number) => {
  await apiFetch(`/api/integrations/mcp/connections/${id}`, {
    method: "DELETE",
  });
};
