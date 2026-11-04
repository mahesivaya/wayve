// Personal accounts upgrade to the Organization / Advanced Organization plans
// from the Billing page. Enterprise stays sales-led.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  switchMode: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  startOrganizationUpgrade: vi.fn(),
  finalizeOrganizationUpgrade: vi.fn(),
  startInlineSubscription: vi.fn(),
  subscription: {} as Record<string, unknown>,
  org: null as Record<string, unknown> | null,
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: h.user,
    refresh: h.refresh,
    switchMode: h.switchMode,
  }),
}));

vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}));

const plan = (
  id: number,
  code: string,
  name: string,
  audience: string,
  tier: string,
  amount_cents: number
) => ({
  id,
  code,
  name,
  description: null,
  audience,
  tier,
  stripe_price_id: amount_cents ? "price_x" : null,
  amount_cents,
  currency: "usd",
  billing_interval: "month",
  storage_limit_bytes: 0,
  seat_limit: 1,
  features: {},
  is_active: true,
});

vi.mock("../../api/billing", () => ({
  listPlans: async () => [
    plan(1, "basic_user", "Personal", "personal", "personal", 0),
    plan(2, "business_startups", "Organization", "organization", "startups", 0),
    plan(
      3,
      "organization",
      "Advanced Organization",
      "organization",
      "business",
      1200
    ),
    plan(4, "enterprise", "Enterprise", "organization", "enterprise", 4900),
  ],
  getSubscription: async () => h.subscription,
  getEntitlements: async () => null,
  listInvoices: async () => [],
  getUsage: async () => null,
  getStripeStatus: async () => ({
    configured: true,
    test_mode: true,
    country: "US",
    publishable_key: "pk_test_x",
  }),
  getOrganizationBilling: async () => h.org,
  cancelSubscription: vi.fn(),
  createPaymentMethodSetupIntent: vi.fn(),
  setDefaultPaymentMethod: vi.fn(),
  startInlineSubscription: h.startInlineSubscription,
  startOrganizationUpgrade: h.startOrganizationUpgrade,
  finalizeOrganizationUpgrade: h.finalizeOrganizationUpgrade,
}));

vi.mock("../../api/client", () => ({ invalidateGetCache: vi.fn() }));
vi.mock("../../api/cache", () => ({
  cachedLoad: (_key: string, _ttl: number, load: () => unknown) => load(),
}));
vi.mock("../../api/featureAccess", () => ({ getFeatureAccess: vi.fn() }));

import Billing from "../../billing/Billing";

const renderBilling = async () => {
  render(
    <MemoryRouter>
      <Billing />
    </MemoryRouter>
  );
  await screen.findByRole("heading", {
    name: "Advanced Organization",
    level: 3,
  });
};

const cardButton = (planName: string) => {
  const card = screen
    .getByRole("heading", { name: planName, level: 3 })
    .closest("article");
  const button = card?.querySelector("button");
  if (!button) throw new Error(`no button on ${planName}`);
  return button;
};

const openForm = (planName: string, orgName: string) => {
  fireEvent.click(cardButton(planName));
  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: orgName },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { account_type: "personal", scope: "personal", email: "a@b.c" };
  h.switchMode.mockResolvedValue(undefined);
  h.refresh.mockResolvedValue(undefined);
  h.subscription = { owner_type: "personal", subscription: null };
  h.org = null;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("organization upgrade", () => {
  it("offers Upgrade on both org plans and leaves Enterprise with sales", async () => {
    await renderBilling();
    expect(cardButton("Organization").textContent).toBe("Upgrade");
    expect(cardButton("Advanced Organization").textContent).toBe("Upgrade");
    expect(cardButton("Enterprise").textContent).toBe("Contact sales");
  });

  it("does not offer it to platform staff, who bill as personal", async () => {
    h.user = { account_type: "platform_admin", scope: "platform" };
    await renderBilling();
    expect(cardButton("Organization").textContent).toBe("Contact sales");
  });

  it("creates the free org, then enters it in admin mode", async () => {
    h.startOrganizationUpgrade.mockResolvedValue({ organization_id: 7 });
    await renderBilling();
    openForm("Organization", "  Acme  ");
    fireEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );

    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith("/organization/home", {
        replace: true,
      })
    );
    expect(h.startOrganizationUpgrade).toHaveBeenCalledWith(
      "business_startups",
      "Acme"
    );
    expect(h.switchMode).toHaveBeenCalledWith("admin");
  });

  it("keeps the form and shows why when the free upgrade is refused", async () => {
    h.startOrganizationUpgrade.mockRejectedValue(
      new Error("An organization named 'Acme' already exists")
    );
    await renderBilling();
    openForm("Organization", "Acme");
    fireEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );

    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(screen.getByLabelText("Organization name")).toBeTruthy();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("asks for payment on the paid plan, without using the personal flow", async () => {
    h.startOrganizationUpgrade.mockRejectedValue(new Error("name taken"));
    await renderBilling();
    openForm("Advanced Organization", "Acme");
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to payment" })
    );

    // Refused before payment: back on the name form with the reason.
    expect(await screen.findByText("name taken")).toBeTruthy();
    expect(h.startOrganizationUpgrade).toHaveBeenCalledWith(
      "organization",
      "Acme"
    );
    expect(h.startInlineSubscription).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Organization name")).toBeTruthy();
  });

  it("charges an organization for each of its users", async () => {
    h.subscription = {
      owner_type: "organization",
      subscription: {
        id: 1,
        status: "active",
        current_period_end: null,
        cancel_at_period_end: false,
        plan_code: "organization",
        plan_name: "Advanced Organization",
        amount_cents: 1200,
        currency: "usd",
        billing_interval: "month",
      },
    };
    h.org = {
      organization: { id: 5, name: "Acme", slug: "acme" },
      seats_used: 3,
      seat_limit: 100,
      plan_code: "organization",
      plan_active: true,
    };
    await renderBilling();

    expect(await screen.findByText("3 × 12.00 USD")).toBeTruthy();
    expect(screen.getByText("36.00 USD / month")).toBeTruthy();
  });

  it("states the per-user price before upgrading", async () => {
    await renderBilling();
    fireEvent.click(cardButton("Advanced Organization"));
    expect(screen.getByText(/12\.00 USD per user \/ month/)).toBeTruthy();
  });

  it("requires a name", async () => {
    await renderBilling();
    fireEvent.click(cardButton("Organization"));
    const submit = screen.getByRole("button", { name: "Create organization" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });
});
