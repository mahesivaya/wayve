// Platform Analytics → Mobile Installs: totals, App Store / TestFlight counts
// (0 when a channel has none yet), the per-version breakdown and recent installs.
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PlatformMobileInstalls from "../../platformTeam/PlatformMobileInstalls";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "owner@fluxze.com",
      scope: "platform",
      account_type: "platform_admin",
      effective_role: "owner",
      permissions: ["audit:read"],
    },
  }),
}));

vi.mock("../../api/mobileInstalls", () => ({
  getMobileInstallStats: vi.fn().mockResolvedValue({
    total: 6,
    active_30_days: 4,
    new_30_days: 3,
    by_platform: [{ key: "ios", count: 6 }],
    by_channel: [{ key: "testflight", count: 6 }],
    by_version: [
      { key: "1.2.1", count: 4 },
      { key: "1.2.0", count: 2 },
    ],
    by_location: [
      { country: "India", region: "Telangana", city: "Hyderabad", count: 6 },
    ],
    recent: [
      {
        id: 1,
        platform: "ios",
        channel: "testflight",
        app_version: "1.2.1",
        build: "2",
        os_version: "18.1",
        device_model: "iPhone16,2",
        user_id: null,
        user_email: null,
        ip: "203.0.113.9",
        country: "India",
        region: "Telangana",
        city: "Hyderabad",
        launches: 3,
        first_seen_at: "2026-11-12T10:00:00Z",
        last_seen_at: "2026-11-13T10:00:00Z",
      },
    ],
  }),
}));

describe("PlatformMobileInstalls", () => {
  it("shows install totals, sources, versions and recent installs", async () => {
    render(<PlatformMobileInstalls />);

    const byVersion = (
      await screen.findByRole("heading", { name: "Installs by version" })
    ).closest("section") as HTMLElement;
    expect(
      within(byVersion)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.textContent)
    ).toEqual(["1.2.14", "1.2.02"]);

    const stats = Array.from(document.querySelectorAll(".pt-stat")).map(
      (el) => [
        el.querySelector(".pt-stat-label")?.textContent,
        el.querySelector(".pt-stat-value")?.textContent,
      ]
    );
    expect(stats).toEqual([
      ["Installs", "6"],
      ["Active", "4"],
      ["New", "3"],
      ["App Store", "0"],
      ["TestFlight", "6"],
    ]);

    const recent = (
      screen
        .getByRole("heading", { name: "Recent installs" })
        .closest("section") as HTMLElement
    ).querySelector("tbody") as HTMLElement;
    expect(within(recent).getByText("1.2.1 (2)")).toBeTruthy();
    expect(within(recent).getByText("iPhone16,2 · iOS 18.1")).toBeTruthy();
    expect(within(recent).getByText("Not signed in")).toBeTruthy();
  });
});
