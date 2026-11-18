// The AI provider page shows token usage inline: an organization's owner sees
// its own totals by member and model, the platform owner sees the whole site by
// scope and by platform team member.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mockAuth: { user: Record<string, unknown> | null } = { user: null };
vi.mock("../../auth/useAuth", () => ({ useAuth: () => mockAuth }));

vi.mock("../../api/aiProvider", () => ({
  getAiConfig: vi.fn().mockResolvedValue({
    providers: [
      {
        id: "anthropic",
        label: "Claude",
        default_model: "claude-opus-4-8",
        needs_base_url: false,
      },
    ],
    config: {
      configured: false,
      provider: null,
      model: null,
      base_url: null,
      has_key: false,
      fail_closed: true,
      last_validated_at: null,
    },
  }),
  putAiConfig: vi.fn(),
  deleteAiConfig: vi.fn(),
  getAiDataAccess: vi.fn().mockResolvedValue({ email: true, calendar: true }),
  putAiDataAccess: vi.fn(),
  getAiUsage: vi.fn(),
}));

import AiSettings from "../../settings/AiSettings";
import { getAiUsage } from "../../api/aiProvider";

const mockUsage = getAiUsage as unknown as {
  mockResolvedValue: (v: unknown) => void;
};

const baseUsage = {
  sample: false,
  provider: "anthropic",
  model: null,
  period: "Last 30 days",
  totals: {
    requests: 7,
    input_tokens: 1200,
    output_tokens: 345,
    cost_cents: 0,
    active_users: 2,
  },
  budget: { monthly_limit_cents: 0, spent_cents: 0, alert_threshold_pct: 80 },
  daily: [],
  by_model: [
    { model: "claude-opus-4-8", requests: 7, tokens: 1545, cost_cents: 0 },
  ],
  by_member: [{ name: "Asha Rao", requests: 7, tokens: 1545, cost_cents: 0 }],
  by_scope: [],
  platform_members: [],
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <AiSettings />
    </MemoryRouter>
  );

const kpi = (label: string) =>
  screen.getByText(label).parentElement as HTMLElement;

describe("AI provider page token usage", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockAuth.user = null;
  });

  it("shows an organization owner its totals, by member and by model", async () => {
    mockAuth.user = { permissions: ["ai:manage"], scope: "organization" };
    mockUsage.mockResolvedValue(baseUsage);

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Token usage" })
    ).toBeTruthy();
    expect(await screen.findByText("Total tokens")).toBeTruthy();
    expect(within(kpi("Total tokens")).getByText("1,545")).toBeTruthy();
    expect(within(kpi("Input tokens")).getByText("1,200")).toBeTruthy();
    expect(within(kpi("Output tokens")).getByText("345")).toBeTruthy();
    expect(within(kpi("Requests")).getByText("7")).toBeTruthy();

    expect(screen.getByRole("heading", { name: "By member" })).toBeTruthy();
    expect(screen.getByText("Asha Rao")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "By model" })).toBeTruthy();
    // The site-wide breakdown is the platform owner's only.
    expect(screen.queryByText(/by scope/i)).toBeNull();
  });

  it("shows the platform owner the whole site by scope and by team member", async () => {
    mockAuth.user = { permissions: ["ai:manage"], scope: "platform" };
    mockUsage.mockResolvedValue({
      ...baseUsage,
      by_scope: [
        { label: "Personal users", kind: "personal", tokens: 900, requests: 4 },
        { label: "Acme", kind: "organization", tokens: 500, requests: 2 },
        { label: "Platform team", kind: "platform", tokens: 145, requests: 1 },
      ],
      platform_members: [{ name: "Priya Shah", tokens: 145, requests: 1 }],
    });

    renderPage();

    expect(
      await screen.findByRole("heading", {
        name: "Complete website usage — by scope",
      })
    ).toBeTruthy();
    expect(screen.getByText("Personal users")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Platform team members" })
    ).toBeTruthy();
    expect(screen.getByText("Priya Shah")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "By member" })).toBeNull();
  });

  it("says so when nobody has used the AI yet", async () => {
    mockAuth.user = { permissions: ["ai:manage"], scope: "organization" };
    mockUsage.mockResolvedValue({
      ...baseUsage,
      totals: {
        ...baseUsage.totals,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
      },
      by_model: [],
      by_member: [],
    });

    renderPage();

    expect(await screen.findByText("No member usage yet.")).toBeTruthy();
    expect(screen.getByText("No AI usage yet.")).toBeTruthy();
  });

  it("loads no usage for someone who cannot manage AI", () => {
    mockAuth.user = { permissions: [], scope: "organization" };

    renderPage();

    expect(screen.queryByRole("heading", { name: "Token usage" })).toBeNull();
    expect(getAiUsage).not.toHaveBeenCalled();
  });
});
