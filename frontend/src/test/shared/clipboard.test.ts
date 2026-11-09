import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../../utils/clipboard";

// jsdom has no execCommand; give the fallback something to call.
function stubExecCommand(result: boolean) {
  const fn = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", {
    value: fn,
    configurable: true,
    writable: true,
  });
  return fn;
}

function stubClipboard(writeText: ((t: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

describe("copyText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the Clipboard API when it works", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const exec = stubExecCommand(true);

    await expect(copyText("alpha beta")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("alpha beta");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the Clipboard API is refused (desktop shell)", async () => {
    stubClipboard(() => Promise.reject(new DOMException("denied")));
    const exec = stubExecCommand(true);

    await expect(copyText("alpha beta")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    // The temporary textarea is cleaned up.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when there is no Clipboard API at all", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(true);

    await expect(copyText("alpha")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("reports failure when both paths fail, instead of failing silently", async () => {
    stubClipboard(() => Promise.reject(new DOMException("denied")));
    stubExecCommand(false);

    await expect(copyText("alpha")).resolves.toBe(false);
  });
});
