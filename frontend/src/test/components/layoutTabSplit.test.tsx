// Dragging a header tab past the middle of the page opens its exact URL in a
// right column. That column's app key is only a placeholder, so it must not be
// treated as a duplicate of the same app on the left — the Tickets board beside
// ticket #6 used to be "deduped" away, which looked like the drag closed the tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("once split, a tab dragged within its own pane previews nothing", () => {
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
    fireEvent.dragStart(tab, { dataTransfer: dataTransfer() });
    // No "past the middle" half-pane target on the left any more; only the
    // other pane takes the tab.
    expect(
      container.querySelector(".split-pane.left .pane-drop-overlay")
    ).toBeNull();
    expect(
      container.querySelector(".split-pane.right .pane-drop-overlay")
    ).toBeTruthy();
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

  it("dragging a group's last tab to the other side leaves one screen", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: "a", path: "/tickets" }], activeId: "a" })
    );
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

    // The main strip's only tab → the right pane: the left group closes.
    const tab = screen.getByRole("tab", { name: "Tickets" });
    const dt = dataTransfer();
    fireEvent.dragStart(tab, { dataTransfer: dt });
    const overlay = container.querySelector(
      ".split-pane.right .pane-drop-overlay"
    ) as HTMLElement;
    fireEvent.dragOver(overlay, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(overlay, { dataTransfer: dt });
    });
    fireEvent.dragEnd(tab, { dataTransfer: dt });

    expect(container.querySelector(".split-pane.right")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Right pane tabs" })).toBe(
      null
    );
    expect(
      within(screen.getByRole("tablist", { name: "Open tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tasks", "Tickets"]);
  });

  it("dragging the right pane's only tab to the left closes the split", () => {
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
    const right = screen.getByRole("tablist", { name: "Right pane tabs" });
    const tab = within(right).getByRole("tab", { name: "Tasks" });
    const dt = dataTransfer();
    fireEvent.dragStart(tab, { dataTransfer: dt });
    const overlay = container.querySelector(
      ".split-pane.left .pane-drop-overlay"
    ) as HTMLElement;
    fireEvent.dragOver(overlay, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(overlay, { dataTransfer: dt });
    });
    fireEvent.dragEnd(tab, { dataTransfer: dt });

    expect(container.querySelector(".split-pane.right")).toBeNull();
    expect(
      within(screen.getByRole("tablist", { name: "Open tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tickets", "Tasks", "#6 Performance fix"]);
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

  it("a sidebar click into the focused right group adds a tab there", () => {
    // Right column showing Tasks, and it has focus.
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
    const rightTabs = () =>
      within(screen.getByRole("tablist", { name: "Right pane tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent);
    const mainTabs = () =>
      within(screen.getByRole("tablist", { name: "Open tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent);
    const before = mainTabs();
    // Focus the right pane by clicking into it, as a user would.
    fireEvent.mouseDown(
      container.querySelector(".split-pane.right .split-pane-body") ??
        (container.querySelector(".split-pane.right") as HTMLElement)
    );

    act(() => {
      fireEvent.click(screen.getByRole("link", { name: /Notes/ }));
    });
    // Tasks is kept; Notes opens as a new tab beside it.
    expect(rightTabs()).toEqual(["Tasks", "Notes"]);
    act(() => {
      fireEvent.click(screen.getByRole("link", { name: /Chat/ }));
    });
    expect(rightTabs()).toEqual(["Tasks", "Notes", "Chat"]);
    // Opening one that's already there selects it instead of duplicating.
    act(() => {
      fireEvent.click(screen.getByRole("link", { name: /Notes/ }));
    });
    expect(rightTabs()).toEqual(["Tasks", "Notes", "Chat"]);
    // The main strip is untouched.
    expect(mainTabs()).toEqual(before);
  });

  it("sidebar clicks stay in the main pane unless the right one was clicked", () => {
    // A stale "right" focus from a previous session must not be restored.
    window.localStorage.setItem(
      "rwayve.layout.split",
      JSON.stringify({ rightView: "tasks", splitTarget: "right" })
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
    act(() => {
      fireEvent.click(screen.getByRole("link", { name: /Notes/ }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("link", { name: /Chat/ }));
    });
    // The right group gained no tabs.
    expect(
      within(screen.getByRole("tablist", { name: "Right pane tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tasks"]);
  });

  it("dropping a tab into the right group doesn't redirect sidebar clicks", () => {
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
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect;
    const at = (make: typeof createEvent.dragOver) => {
      const ev = make(overlay, { dataTransfer: dt });
      Object.defineProperty(ev, "clientX", { value: 800 });
      return ev;
    };
    fireEvent(overlay, at(createEvent.dragOver));
    act(() => {
      fireEvent(overlay, at(createEvent.drop));
    });
    fireEvent.dragEnd(tab, { dataTransfer: dt });

    act(() => {
      fireEvent.click(screen.getByRole("link", { name: /Notes/ }));
    });
    expect(
      within(screen.getByRole("tablist", { name: "Right pane tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["#6 Performance fix"]);
  });

  it("shows Split right at the end of the tabs only while unsplit", () => {
    render(
      <MemoryRouter initialEntries={["/tickets"]}>
        <PaneRoutesContext.Provider value={renderRoutes}>
          <Layout>
            <p>board</p>
          </Layout>
        </PaneRoutesContext.Provider>
      </MemoryRouter>
    );

    const main = screen.getByRole("tablist", { name: "Open tabs" });
    act(() => {
      fireEvent.click(
        within(main).getByRole("button", { name: "Split right" })
      );
    });

    expect(
      screen.getByRole("tablist", { name: "Right pane tabs" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split right" })).toBeNull();
  });

  it("'Split left' moves the page to a new right pane and opens Home here", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: "a", path: "/tickets" }], activeId: "a" })
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

    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Split left/ }));
    });

    const right = screen.getByRole("tablist", { name: "Right pane tabs" });
    expect(
      within(right)
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tickets"]);
    expect(screen.getByTestId("pane-page")).toHaveTextContent("/tickets");
    expect(
      within(screen.getByRole("tablist", { name: "Open tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Home"]);
  });

  it("Ctrl+/ splits left, like the menu item", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: "a", path: "/tickets" }], activeId: "a" })
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

    act(() => {
      fireEvent.keyDown(document, { key: "/", ctrlKey: true });
    });

    expect(
      within(screen.getByRole("tablist", { name: "Right pane tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Tickets"]);
    expect(
      within(screen.getByRole("tablist", { name: "Open tabs" }))
        .getAllByRole("tab")
        .map((t) => t.textContent)
    ).toEqual(["Home"]);
  });

  describe("shrunk sidebar hover", () => {
    const renderShrunk = () => {
      window.localStorage.setItem("rwayve.sidebar.collapsed", "1");
      const view = render(
        <MemoryRouter initialEntries={["/tickets"]}>
          <PaneRoutesContext.Provider value={renderRoutes}>
            <Layout>
              <p>board</p>
            </Layout>
          </PaneRoutesContext.Provider>
        </MemoryRouter>
      );
      const nav = view.container.querySelector("nav.sidebar") as HTMLElement;
      return nav;
    };
    afterEach(() => {
      vi.useRealTimers();
      delete (window as { fluxzeDesktop?: unknown }).fluxzeDesktop;
    });

    it("lets the browser shrink and expand it from the brand toggle", () => {
      const nav = renderShrunk(); // a saved "shrunk" preference
      expect(nav).toHaveClass("collapsed");

      fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expect(nav).not.toHaveClass("collapsed");
      expect(window.localStorage.getItem("rwayve.sidebar.collapsed")).toBe("0");

      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(nav).toHaveClass("collapsed");
    });

    it.each([
      ["the browser", false],
      ["the desktop app", true],
    ])("peeks the shrunk rail open on hover in %s", (_name, desktop) => {
      vi.useFakeTimers();
      if (desktop) {
        (window as { fluxzeDesktop?: unknown }).fluxzeDesktop = {
          isDesktop: true,
        };
      }
      const nav = renderShrunk();
      expect(nav).toHaveClass("collapsed");
      // Shrunk, the desktop app hides the icon rail entirely (leaving a hover
      // strip at the window's edge); the browser keeps its icons.
      const hasRailHidden = () => nav.classList.contains("rail-hidden");
      expect(hasRailHidden()).toBe(desktop);

      fireEvent.mouseEnter(nav);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(nav).toHaveClass("peek");
      expect(nav).not.toHaveClass("collapsed");
      expect(hasRailHidden()).toBe(false);

      fireEvent.mouseLeave(nav);
      expect(nav).toHaveClass("collapsed");
      expect(nav).not.toHaveClass("peek");
      expect(hasRailHidden()).toBe(desktop);
      // Peeking never changes the saved choice.
      expect(window.localStorage.getItem("rwayve.sidebar.collapsed")).toBe("1");
    });
  });
});
