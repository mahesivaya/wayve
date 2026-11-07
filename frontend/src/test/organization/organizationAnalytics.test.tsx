// /organization/analytics holds the User Stories sprint chart, moved off the
// organization home. Every organization member can open it; anyone else is
// sent back to "/".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const auth = vi.hoisted(() => ({
  user: null as null | { email: string; scope: string },
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: auth.user }),
}));

// The chart fetches stories and history on mount; its own behaviour is covered
// by userStoriesTimeline.test.tsx. Here we only care that the page shows it.
vi.mock("../../organization/UserStoriesSummaryCard", () => ({
  default: () => <div data-testid="sprint-chart">chart</div>,
}));

import OrganizationAnalytics from "../../organization/OrganizationAnalytics";

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/organization/analytics"]}>
      <Routes>
        <Route
          path="/organization/analytics"
          element={<OrganizationAnalytics />}
        />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("OrganizationAnalytics", () => {
  beforeEach(() => {
    auth.user = null;
  });

  it("shows the sprint chart to an organization member", () => {
    auth.user = { email: "member@fluxze.com", scope: "organization" };
    renderAt();
    expect(
      screen.getByRole("heading", { name: "Analytics" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("sprint-chart")).toBeInTheDocument();
  });

  it.each(["personal", "platform"])("sends a %s user back home", (scope) => {
    auth.user = { email: "someone@fluxze.com", scope };
    renderAt();
    expect(screen.getByText("home")).toBeInTheDocument();
    expect(screen.queryByTestId("sprint-chart")).not.toBeInTheDocument();
  });
});
