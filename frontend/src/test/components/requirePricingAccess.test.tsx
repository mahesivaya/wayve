// /pricing route guard. Personal accounts must land where they can actually
// upgrade: Settings › Billing. Plain /settings (General) no longer renders the
// Billing & Plans card on wide screens, so redirecting there strands them.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let mockUser: Record<string, unknown> | null = null;
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));

import RequirePricingAccess from "../../components/RequirePricingAccess";

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={["/pricing"]}>
      <Routes>
        <Route
          path="/pricing"
          element={
            <RequirePricingAccess>
              <div>plan grid</div>
            </RequirePricingAccess>
          }
        />
        <Route path="/settings" element={<div>settings general</div>} />
        <Route path="/settings/billing" element={<div>settings billing</div>} />
        <Route path="/organization/home" element={<div>org home</div>} />
      </Routes>
    </MemoryRouter>
  );

describe("RequirePricingAccess", () => {
  beforeEach(() => {
    mockUser = null;
  });

  it("lets logged-out visitors see the plan grid", () => {
    renderAt();
    expect(screen.getByText("plan grid")).toBeTruthy();
  });

  it("sends personal accounts to Settings › Billing, not General", () => {
    mockUser = { id: 1, account_type: "personal", scope: "personal" };
    renderAt();
    expect(screen.getByText("settings billing")).toBeTruthy();
    expect(screen.queryByText("settings general")).toBeNull();
  });

  it("lets an org owner see the plan grid", () => {
    mockUser = {
      id: 2,
      account_type: "organization_admin",
      scope: "organization",
      effective_role: "owner",
    };
    renderAt();
    expect(screen.getByText("plan grid")).toBeTruthy();
  });
});
