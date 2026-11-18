// In a phone browser the opened menu is drawn over the page, so a tap outside
// it closes it again; nobody should have to find the collapse button. Desktop
// keeps its menu open until the button is used. A phone browser also has no
// room for two columns or a row of tabs, so it gets neither the split view nor
// the tab strip.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const phone = vi.hoisted(() => ({ value: true }));
vi.mock("../../components/useIsNarrow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/useIsNarrow")>()),
  useIsPhone: () => phone.value,
}));
// Layout pulls in a lot of the app shell. None of it is what's under test, so
// each dependency is stubbed down to the shape Layout actually consumes.
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

vi.mock("../../notes/Notes", () => ({ default: () => <div>notes page</div> }));
vi.mock("../../home/Home", () => ({ default: () => <div>home page</div> }));

import Layout from "../../components/Layout";
import { loadState, saveState } from "../../components/tabs/tabsModel";

const twoTabs = {
  tabs: [
    { id: "a", path: "/home" },
    { id: "b", path: "/notes" },
  ],
  activeId: "a",
};

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/home"]}>
      <Layout>
        <div />
      </Layout>
    </MemoryRouter>
  );
}

const scrim = (container: HTMLElement) =>
  container.querySelector(".sidebar-scrim--phone");
const sidebar = (container: HTMLElement) =>
  container.querySelector("nav.sidebar");

describe("Layout menu on a phone", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The menu is open (expanded) to begin with.
    window.localStorage.setItem("rwayve.sidebar.collapsed", "0");
  });

  it("closes the open menu on a tap outside it", async () => {
    phone.value = true;
    const user = userEvent.setup();
    const { container } = renderLayout();
    expect(sidebar(container)).not.toHaveClass("collapsed");
    const outside = scrim(container);
    expect(outside).not.toBeNull();

    await user.click(outside as Element);

    expect(sidebar(container)).toHaveClass("collapsed");
    expect(scrim(container)).toBeNull();
  });

  it("closes a menu that a tap on the rail peeked open", async () => {
    phone.value = true;
    window.localStorage.setItem("rwayve.sidebar.collapsed", "1");
    const user = userEvent.setup();
    const { container } = renderLayout();
    expect(sidebar(container)).toHaveClass("collapsed");
    expect(scrim(container)).toBeNull();

    // What a touch browser sends for a tap on the rail.
    await user.hover(sidebar(container) as Element);
    await waitFor(() => expect(scrim(container)).not.toBeNull());
    expect(sidebar(container)).toHaveClass("peek");

    await user.click(scrim(container) as Element);

    expect(sidebar(container)).toHaveClass("collapsed");
    expect(sidebar(container)).not.toHaveClass("peek");
    expect(scrim(container)).toBeNull();
  });

  it("offers no split view", () => {
    phone.value = true;
    const { container } = renderLayout();
    expect(container.querySelector(".app-tab-split")).toBeNull();
  });

  it("offers the split view on a desktop", () => {
    phone.value = false;
    const { container } = renderLayout();
    expect(container.querySelector(".app-tab-split")).not.toBeNull();
  });

  it("shows no tabs and no way to open one", () => {
    phone.value = true;
    saveState(twoTabs);
    const { container } = renderLayout();
    expect(container.querySelectorAll(".app-tab")).toHaveLength(0);
    expect(container.querySelector(".app-tab-add")).toBeNull();
    // The saved tabs are only unlisted, not thrown away.
    expect(loadState()?.tabs).toHaveLength(2);
  });

  it("keeps every tab and the new-tab button on a desktop", () => {
    phone.value = false;
    saveState(twoTabs);
    const { container } = renderLayout();
    expect(container.querySelectorAll(".app-tab")).toHaveLength(2);
    expect(container.querySelector(".app-tab-add")).not.toBeNull();
  });

  it("has nothing to tap outside the menu on a desktop", () => {
    phone.value = false;
    const { container } = renderLayout();
    expect(sidebar(container)).not.toHaveClass("collapsed");
    expect(scrim(container)).toBeNull();
  });
});
