// Platform Analytics → Desktop Downloads: totals, per-build counts and the
// per-location breakdown, with unlocatable downloads shown as "Unknown".
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PlatformDesktopDownloads from "../../platformTeam/PlatformDesktopDownloads";

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

vi.mock("../../api/desktopDownloads", () => ({
  getDesktopDownloadStats: vi.fn().mockResolvedValue({
    total: 7,
    unique_ips: 5,
    last_30_days: 4,
    by_build: [
      { build: "mac-arm64", count: 5 },
      { build: "mac-x64", count: 2 },
    ],
    by_location: [
      { country: "India", region: "Telangana", city: "Hyderabad", count: 4 },
      { country: null, region: null, city: null, count: 3 },
    ],
    recent: [
      {
        id: 1,
        build: "mac-arm64",
        user_id: null,
        user_email: null,
        ip: "203.0.113.9",
        user_agent: null,
        country: "India",
        region: "Telangana",
        city: "Hyderabad",
        created_at: "2026-11-06T10:00:00Z",
      },
    ],
  }),
}));

describe("PlatformDesktopDownloads", () => {
  it("shows the totals and where downloads came from", async () => {
    render(<PlatformDesktopDownloads />);

    const byLocation = (
      await screen.findByRole("heading", { name: "Downloads by location" })
    ).closest("section") as HTMLElement;
    const rows = within(byLocation).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "Hyderabad, Telangana, India4",
      "Unknown3",
    ]);

    const stats = Array.from(document.querySelectorAll(".pt-stat")).map(
      (el) => [
        el.querySelector(".pt-stat-label")?.textContent,
        el.querySelector(".pt-stat-value")?.textContent,
      ]
    );
    expect(stats).toEqual([
      ["Downloads", "7"],
      ["Unique IPs", "5"],
      ["Last 30 days", "4"],
      ["macOS · Apple Silicon", "5"],
      ["macOS · Intel", "2"],
    ]);
    expect(screen.getByText("Anonymous")).toBeTruthy();
  });
});
