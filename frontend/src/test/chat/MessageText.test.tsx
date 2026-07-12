import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MessageText from "../../chat/components/MessageText";

const renderText = (text: string) =>
  render(
    <MemoryRouter>
      <MessageText text={text} />
    </MemoryRouter>
  );

describe("MessageText", () => {
  it("renders plain text without any links", () => {
    renderText("just a normal message");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("just a normal message")).toBeTruthy();
  });

  it("turns a copied task snippet into an in-app router link", () => {
    renderText("#42 Ship the thing");
    const link = screen.getByRole("link", { name: "#42 Ship the thing" });
    expect(link.getAttribute("href")).toBe("/tasks?ref=42");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("peels trailing punctuation off a task snippet", () => {
    renderText("see #42 Ship the thing.");
    const link = screen.getByRole("link", { name: "#42 Ship the thing" });
    expect(link.getAttribute("href")).toBe("/tasks?ref=42");
    expect(link.textContent).toBe("#42 Ship the thing");
  });

  it("turns a same-origin task URL into an in-app router link", () => {
    const url = `${window.location.origin}/tasks?task=42`;
    renderText(`check this out ${url}`);
    const link = screen.getByRole("link", { name: url });
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

  it("peels trailing punctuation out of a URL", () => {
    const url = `${window.location.origin}/tasks?task=7`;
    renderText(`open ${url}.`);
    const link = screen.getByRole("link", { name: url });
    expect(link.getAttribute("href")).toBe("/tasks?task=7");
    expect(link.textContent).toBe(url);
  });
});
