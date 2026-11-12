// Dragging a header tab past the middle of the page opens its exact URL in a
// right column. That column's app key is only a placeholder, so it must not be
// treated as a duplicate of the same app on the left — the Tickets board beside
// ticket #6 used to be "deduped" away, which looked like the drag closed the tab.
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PaneRoutesContext } from "../../components/tabs/paneContexts";
import { STORAGE_KEY } from "../../components/tabs/tabsModel";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "u@test.local", account_type: "personal" },
    logout: vi.fn(),
  }),
}));
vi.mock("../../auth/permissions", () => ({
  hasPermission: () => true,
  canViewIntegrations: () => true,
}));
vi.mock("../../api/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("../../api/workspace", () => ({
  listTeams: vi.fn().mockResolvedValue([]),
  createTeam: vi.fn(),
}));
vi.mock("../../emails/useEmailsUnreadCount", () => ({
  useEmailsUnreadCount: () => 0,
}));
vi.mock("../../chat/useChatUnreadCount", () => ({
  useChatUnreadCount: () => 0,
}));
vi.mock("../../tickets/useTicketsOpenCount", () => ({
  useTicketsOpenCount: () => 0,
}));
vi.mock("../../userstories/useUserStoriesCount", () => ({
  useUserStoriesCount: () => 0,
}));
vi.mock("../../search/SearchProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../search/SearchBar", () => ({ default: () => null }));
vi.mock("../../components/NotificationBell", () => ({ default: () => null }));
vi.mock("../../components/ReminderPopups", () => ({ default: () => null }));
vi.mock("../../components/StorageLimitBanner", () => ({ default: () => null }));
vi.mock("../../components/ProfileMenu", () => ({ default: () => null }));

import Layout from "../../components/Layout";

const renderRoutes = (location?: string) => (
  <p data-testid="pane-page">{location ?? "main"}</p>
);

function dataTransfer() {
  const store = new Map<string, string>();
  return {
    setData: (k: string, v: string) => store.set(k, v),
    getData: (k: string) => store.get(k) ?? "",
    get types() {
      return Array.from(store.keys());
    },
    effectAllowed: "all",
    dropEffect: "none",
  };
}

describe("dragging a header tab into a split", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Two tabs: the Tickets board (active) and ticket #6.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { id: "a", path: "/tickets" },
          { id: "b", path: "/tickets/6", title: "#6 Performance fix" },
        ],
        activeId: "a",
      })
    );
  });

  it("keeps the split open when both panes belong to the same app", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/tickets"]}>
        <PaneRoutesContext.Provider value={renderRoutes}>
          <Layout>
            <p>board</p>
          </Layout>
        </PaneRoutesContext.Provider>
      </MemoryRouter>
    );

    const tab = screen.getByRole("tab", { name: /#6 Performance fix/ });
    const dt = dataTransfer();
    fireEvent.dragStart(tab, { dataTransfer: dt });

    const overlay = container.querySelector(
      ".split-pane.left .pane-drop-overlay"
    ) as HTMLElement;
    expect(overlay).toBeTruthy();
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect;
    // Past the middle: the right half. jsdom has no DragEvent, so the pointer
    // position is attached to the event by hand.
    const at = (make: typeof createEvent.dragOver) => {
      const ev = make(overlay, { dataTransfer: dt });
      Object.defineProperty(ev, "clientX", { value: 800 });
      Object.defineProperty(ev, "clientY", { value: 300 });
      return ev;
    };
    fireEvent(overlay, at(createEvent.dragOver));
    act(() => {
      fireEvent(overlay, at(createEvent.drop));
    });
    fireEvent.dragEnd(tab, { dataTransfer: dt });

    // The ticket opened beside the board and stayed open...
    expect(container.querySelector(".split-pane.right")).toBeTruthy();
    expect(screen.getByTestId("pane-page")).toHaveTextContent("/tickets/6");
    expect(screen.getByText("board")).toBeTruthy();
    // ...and moved out of the main strip into the right group's own strip.
    const main = screen.getByRole("tablist", { name: "Open tabs" });
    const right = screen.getByRole("tablist", { name: "Right pane tabs" });
    expect(
      within(main)
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tickets"]);
    expect(
      within(right)
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["#6 Performance fix"]);
  });

  it("adds a dropped tab to an open right pane instead of replacing it", () => {
    // Right column already showing the Tasks app (no group yet).
    window.localStorage.setItem(
      "rwayve.layout.split",
      JSON.stringify({ rightView: "tasks", splitTarget: "left" })
    );
    const { container } = render(
      <MemoryRouter initialEntries={["/tickets"]}>
        <PaneRoutesContext.Provider value={renderRoutes}>
          <Layout>
            <p>board</p>
          </Layout>
        </PaneRoutesContext.Provider>
      </MemoryRouter>
    );

    const tab = screen.getByRole("tab", { name: /#6 Performance fix/ });
    const dt = dataTransfer();
    fireEvent.dragStart(tab, { dataTransfer: dt });
    const overlay = container.querySelector(
      ".split-pane.right .pane-drop-overlay"
    ) as HTMLElement;
    expect(overlay).toBeTruthy();
    fireEvent.dragOver(overlay, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(overlay, { dataTransfer: dt });
    });
    fireEvent.dragEnd(tab, { dataTransfer: dt });

    // Tasks is kept as the group's first tab; the ticket joins it, active.
    const right = screen.getByRole("tablist", { name: "Right pane tabs" });
    const tabs = within(right).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Tasks",
      "#6 Performance fix",
    ]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("pane-page")).toHaveTextContent("/tickets/6");

    // Dragging it back onto the main page returns it to the main strip.
    const back = within(right).getByRole("tab", { name: /#6 Performance fix/ });
    const dt2 = dataTransfer();
    fireEvent.dragStart(back, { dataTransfer: dt2 });
    const leftOverlay = container.querySelector(
      ".split-pane.left .pane-drop-overlay"
    ) as HTMLElement;
    fireEvent.dragOver(leftOverlay, { dataTransfer: dt2 });
    act(() => {
      fireEvent.drop(leftOverlay, { dataTransfer: dt2 });
    });
    fireEvent.dragEnd(back, { dataTransfer: dt2 });

    const main = screen.getByRole("tablist", { name: "Open tabs" });
    expect(
      within(main)
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tickets", "#6 Performance fix"]);
    expect(
      within(screen.getByRole("tablist", { name: "Right pane tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tasks"]);
  });

  it("'+' in the right strip opens a new tab beside the app there", () => {
    window.localStorage.setItem(
      "rwayve.layout.split",
      JSON.stringify({ rightView: "tasks", splitTarget: "left" })
    );
    render(
      <MemoryRouter initialEntries={["/tickets"]}>
        <PaneRoutesContext.Provider value={renderRoutes}>
          <Layout>
            <p>board</p>
          </Layout>
        </PaneRoutesContext.Provider>
      </MemoryRouter>
    );

    const right = screen.getByRole("tablist", { name: "Right pane tabs" });
    expect(
      within(right)
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tasks"]);
    act(() => {
      fireEvent.click(within(right).getByRole("button", { name: "New tab" }));
    });
    const tabs = within(
      screen.getByRole("tablist", { name: "Right pane tabs" })
    ).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Tasks", "Home"]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("pane-page")).toHaveTextContent("/");
  });
});
