import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import McpPanel from "../../integrations/McpPanel";

vi.mock("../../api/mcp", () => ({
  getMcpConnections: vi.fn().mockResolvedValue([]),
  addMcpConnection: vi.fn(),
  updateMcpConnection: vi.fn(),
  deleteMcpConnection: vi.fn(),
}));
import {
  addMcpConnection,
  getMcpConnections,
  updateMcpConnection,
} from "../../api/mcp";

const mockAdd = addMcpConnection as unknown as {
  mockResolvedValue: (v: unknown) => void;
  mock: { calls: unknown[][] };
};

const URL_PLACEHOLDER = "https://mcp.acme.com/mcp";
const LABEL_PLACEHOLDER = "Acme orders DB";

// Wait for the initial getMcpConnections() effect to settle so the "No MCP
// servers connected yet." empty state has rendered (keeps act() warnings away).
const renderPanel = async () => {
  render(<McpPanel />);
  await screen.findByText(/no mcp servers connected yet/i);
};

describe("McpPanel connection blocks", () => {
  beforeEach(() => {
    (getMcpConnections as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it("shows the block picker and hides the fields until a block is picked", async () => {
    await renderPanel();

    // The curated blocks render as radios; detail fields are hidden up front.
    expect(screen.getByRole("radiogroup", { name: /mcp server/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /github/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /custom server/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /connect server/i })
    ).not.toBeInTheDocument();
  });

  it("flags a preset block as Connected when a matching server is registered", async () => {
    (getMcpConnections as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue([
        {
          id: 7,
          label: "Our GitHub",
          server_url: "https://api.githubcopilot.com/mcp/",
          enabled: true,
          server_name: "github",
          last_tool_count: 12,
          last_validated_at: null,
        },
      ]);

    render(<McpPanel />);

    // The GitHub block (host api.githubcopilot.com) gets the Connected badge...
    const github = await screen.findByRole("radio", { name: /github/i });
    expect(github).toHaveTextContent(/connected/i);
    // ...but an unrelated block (Stripe) does not.
    expect(
      screen.getByRole("radio", { name: /stripe/i })
    ).not.toHaveTextContent(/connected/i);
  });

  it("pre-fills label + URL when a preset block is picked, with no paste box", async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole("radio", { name: /github/i }));

    expect(screen.getByPlaceholderText(LABEL_PLACEHOLDER)).toHaveValue("GitHub");
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue(
      "https://api.githubcopilot.com/mcp/"
    );
    // Smart-paste is scoped to the Custom block only.
    expect(screen.queryByPlaceholderText(/paste a url/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /connect server/i })
    ).toBeInTheDocument();
  });

  it("reveals the smart-paste box and blank fields for the Custom block", async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole("radio", { name: /custom server/i }));

    expect(screen.getByPlaceholderText(/paste a url/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(LABEL_PLACEHOLDER)).toHaveValue("");
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue("");
  });

  it("toggles a connected server on/off via the switch", async () => {
    (getMcpConnections as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue([
        {
          id: 9,
          label: "Acme DB",
          server_url: "https://mcp.acme.com/mcp",
          enabled: true,
          server_name: "acme",
          last_tool_count: 4,
          last_validated_at: null,
        },
      ]);
    (
      updateMcpConnection as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue({});

    render(<McpPanel />);
    const toggle = await screen.findByRole("checkbox", { name: /disable acme db/i });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(updateMcpConnection).toHaveBeenCalledWith(9, { enabled: false })
    );
  });

  it("edits a server's settings and saves (rotating the token)", async () => {
    (getMcpConnections as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue([
        {
          id: 9,
          label: "Acme DB",
          server_url: "https://mcp.acme.com/mcp",
          enabled: true,
          server_name: "acme",
          last_tool_count: 4,
          last_validated_at: null,
        },
      ]);
    (
      updateMcpConnection as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue({});

    render(<McpPanel />);
    await userEvent.click(
      await screen.findByRole("button", { name: /^settings$/i })
    );

    const labelInput = screen.getByDisplayValue("Acme DB");
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, "Acme Orders");
    await userEvent.type(
      screen.getByPlaceholderText(/leave blank to keep/i),
      "rotated-token"
    );
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(updateMcpConnection).toHaveBeenCalledWith(9, {
        label: "Acme Orders",
        server_url: "https://mcp.acme.com/mcp",
        auth_token: "rotated-token",
      })
    );
  });

  it("sends the entered values (with bearer token) on Connect", async () => {
    mockAdd.mockResolvedValue({
      id: 1,
      label: "Acme orders DB",
      server_url: "https://mcp.acme.com/mcp",
      enabled: true,
      server_name: "acme",
      last_tool_count: 3,
      last_validated_at: null,
    });

    await renderPanel();
    await userEvent.click(screen.getByRole("radio", { name: /custom server/i }));

    await userEvent.type(
      screen.getByPlaceholderText(LABEL_PLACEHOLDER),
      "Acme orders DB"
    );
    await userEvent.type(
      screen.getByPlaceholderText(URL_PLACEHOLDER),
      "https://mcp.acme.com/mcp"
    );
    await userEvent.selectOptions(screen.getByRole("combobox"), "bearer");
    await userEvent.type(
      screen.getByPlaceholderText(/encrypted at rest/i),
      "secret-token"
    );
    await userEvent.click(
      screen.getByRole("button", { name: /connect server/i })
    );

    await waitFor(() => expect(addMcpConnection).toHaveBeenCalledTimes(1));
    expect(addMcpConnection).toHaveBeenCalledWith({
      label: "Acme orders DB",
      server_url: "https://mcp.acme.com/mcp",
      auth_token: "secret-token",
      auth_type: "bearer",
    });

    // On success the block picker resets (fields collapse back).
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument()
    );
  });
});
