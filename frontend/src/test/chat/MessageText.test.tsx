import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import MessageText from "../../chat/components/MessageText";
import {
  SplitControlContext,
  type SplitControlValue,
} from "../../components/SplitControlContext";

const renderText = (text: string) =>
  render(
    <MemoryRouter>
      <MessageText text={text} />
    </MemoryRouter>
  );

const renderWithSplit = (text: string, value: SplitControlValue) =>
  render(
    <MemoryRouter>
      <SplitControlContext.Provider value={value}>
        <MessageText text={text} />
      </SplitControlContext.Provider>
    </MemoryRouter>
  );

describe("MessageText", () => {
  it("renders plain text without any links", () => {
    renderText("just a normal message");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("just a normal message")).toBeTruthy();
  });

  it("turns a same-origin task link into an in-app router link", () => {
    // The copy-task-link button produces `${origin}/tasks?task=<id>`.
    const url = `${window.location.origin}/tasks?task=42`;
    renderText(`check this out ${url}`);
    const link = screen.getByRole("link", { name: url });
    // Router <Link> renders a relative href (no origin) and no new-tab target,
    // so the click navigates client-side into the tasks deep-link effect.
    expect(link.getAttribute("href")).toBe("/tasks?task=42");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("opens an external URL in a new tab", () => {
    renderText("see https://example.com/docs");
    const link = screen.getByRole("link", { name: "https://example.com/docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("opens a task link in the split pane instead of navigating", async () => {
    const openApp = vi.fn();
    const url = `${window.location.origin}/tasks?task=42`;
    renderWithSplit(`open ${url}`, { openApp, target: null, closeApp: null });
    await userEvent.click(screen.getByRole("link", { name: url }));
    expect(openApp).toHaveBeenCalledWith("tasks", { taskId: 42 });
  });

  it("peels trailing punctuation out of the link", () => {
    const url = `${window.location.origin}/tasks?task=7`;
    renderText(`open ${url}.`);
    const link = screen.getByRole("link", { name: url });
    expect(link.getAttribute("href")).toBe("/tasks?task=7");
    // The trailing period stays as plain text, not part of the anchor.
    expect(link.textContent).toBe(url);
  });
});
