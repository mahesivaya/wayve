// Inside a Layout split pane the emails page is list-only — the pane is too
// narrow to nest the page's own list+detail split inside it — so the layout
// toggle is hidden rather than left there doing nothing.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const setEmailViewLayout = vi.fn();
let emailViewLayout: "list" | "split" = "split";

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({
    searchQuery: "",
    setSearchQuery: vi.fn(),
    emailViewLayout,
    setEmailViewLayout,
  }),
}));

import SearchBar from "../../search/SearchBar";
import { SplitPaneContext } from "../../components/SplitPaneContext";

function renderBar(inSplitPane: boolean, path = "/emails") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SplitPaneContext.Provider value={inSplitPane}>
        <SearchBar />
      </SplitPaneContext.Provider>
    </MemoryRouter>
  );
}

describe("emails layout toggle in a split pane", () => {
  it("hides both layout buttons inside a pane", () => {
    emailViewLayout = "split";
    renderBar(true);

    expect(screen.queryByLabelText("Split view")).toBeNull();
    // The list button goes too: the layout is forced, so it is equally inert.
    expect(screen.queryByLabelText("List view")).toBeNull();
  });

  it("leaves the rest of the search row intact inside a pane", () => {
    emailViewLayout = "split";
    const { container } = renderBar(true);

    expect(container.querySelector(".global-search-box")).toBeTruthy();
    expect(container.querySelector(".email-layout-actions")).toBeNull();
  });

  it("shows both buttons on the full-width page", () => {
    emailViewLayout = "split";
    renderBar(false);

    expect(screen.getByLabelText("Split view")).toBeTruthy();
    expect(screen.getByLabelText("List view")).toBeTruthy();
  });

  it("never rewrites the stored preference, so closing the split restores it", () => {
    // Hiding the control must not also mean silently converting the user to
    // list view for the full-width page.
    emailViewLayout = "split";
    renderBar(true);

    expect(setEmailViewLayout).not.toHaveBeenCalled();
  });
});
