import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import NoteBody from "../../notes/NoteBody";

const show = (content: string) =>
  render(<NoteBody content={content} />).container;

describe("NoteBody", () => {
  it("renders plain text as a paragraph, keeping line breaks", () => {
    const body = show("first line\nsecond line");
    expect(body.querySelector("p")?.textContent).toBe(
      "first line\nsecond line"
    );
  });

  it("renders headings by level", () => {
    show("# One\n\n## Two\n\n### Three");
    expect(screen.getByRole("heading", { level: 3, name: "One" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Two" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 5, name: "Three" })
    ).toBeTruthy();
  });

  it("doesn't treat a hashtag as a heading", () => {
    show("#launch day");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("nests bullets by indentation and returns to the outer level", () => {
    const body = show("- a\n  - a1\n  - a2\n- b");
    const outer = body.querySelector(".note-read-body > ul") as HTMLElement;
    const items = outer.querySelectorAll(":scope > li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelectorAll("ul > li")).toHaveLength(2);
    expect(items[1].querySelector("ul")).toBeNull();
  });

  it("numbers lists from the first number written", () => {
    const body = show("3. three\n4. four");
    expect(body.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(body.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("bolds **text** without treating it as a bullet", () => {
    const body = show("**Objective**: ship it");
    expect(body.querySelector("ul")).toBeNull();
    expect(body.querySelector("strong")?.textContent).toBe("Objective");
    expect(body.querySelector("p")?.textContent).toBe("Objective: ship it");
  });

  it("shows HTML as text instead of running it", () => {
    const body = show("<img src=x onerror=alert(1)>");
    expect(body.querySelector("img")).toBeNull();
    expect(body.textContent).toContain("<img");
  });
});
