// The shortcut hook is the keyboard entry point for the email reading pane, so
// the rules that keep it from misfiring are the whole test surface: a bare key
// must never be stolen from a field the user is typing in, Escape must be the
// one exception (dismissing a composer from inside it is the point), and a key
// another listener already claimed must be left alone.
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useShortcuts, type ShortcutMap } from "../../shared/useShortcuts";

function Probe({ map, enabled }: { map: ShortcutMap; enabled?: boolean }) {
  useShortcuts(map, enabled);
  return (
    <div>
      <input aria-label="field" />
      <textarea aria-label="area" />
      <div contentEditable aria-label="rich" />
    </div>
  );
}

/** fireEvent cannot express "already prevented", so dispatch the real thing. */
function dispatch(
  init: KeyboardEventInit & { key: string },
  prevent = false
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (prevent) event.preventDefault();
  document.dispatchEvent(event);
  return event;
}

describe("useShortcuts", () => {
  it("fires a bare single-key binding", () => {
    const onKey = vi.fn();
    render(<Probe map={{ r: onKey }} />);
    fireEvent.keyDown(document, { key: "r" });
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it("matches a shifted printable character against its bare binding", () => {
    // "#" is Shift+3 on most layouts: the character already encodes the Shift,
    // so it must not normalize to "shift+#".
    const onKey = vi.fn();
    render(<Probe map={{ "#": onKey }} />);
    fireEvent.keyDown(document, { key: "#", shiftKey: true });
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it("treats Cmd and Ctrl alike for mod combos", () => {
    const onKey = vi.fn();
    render(<Probe map={{ "mod+enter": onKey }} />);
    fireEvent.keyDown(document, { key: "Enter", metaKey: true });
    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    expect(onKey).toHaveBeenCalledTimes(2);
  });

  it("does not steal a bare key from a field being typed in", () => {
    const onKey = vi.fn();
    const { getByLabelText } = render(<Probe map={{ r: onKey }} />);
    fireEvent.keyDown(getByLabelText("field"), { key: "r" });
    fireEvent.keyDown(getByLabelText("area"), { key: "r" });

    // jsdom does not implement isContentEditable, so the attribute alone would
    // let this case pass vacuously.
    const rich = getByLabelText("rich");
    Object.defineProperty(rich, "isContentEditable", { value: true });
    fireEvent.keyDown(rich, { key: "r" });

    expect(onKey).not.toHaveBeenCalled();
  });

  it("still fires modifier combos from inside a field", () => {
    const onKey = vi.fn();
    const { getByLabelText } = render(<Probe map={{ "mod+enter": onKey }} />);
    fireEvent.keyDown(getByLabelText("area"), { key: "Enter", metaKey: true });
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it("fires Escape even from inside a field", () => {
    const onKey = vi.fn();
    const { getByLabelText } = render(<Probe map={{ escape: onKey }} />);
    fireEvent.keyDown(getByLabelText("area"), { key: "Escape" });
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it("ignores a key another listener already claimed", () => {
    const onKey = vi.fn();
    render(<Probe map={{ r: onKey }} />);
    dispatch({ key: "r" }, true);
    expect(onKey).not.toHaveBeenCalled();
  });

  it("preventDefaults a key it handles", () => {
    render(<Probe map={{ r: vi.fn() }} />);
    expect(dispatch({ key: "r" }).defaultPrevented).toBe(true);
  });

  it("ignores auto-repeat", () => {
    const onKey = vi.fn();
    render(<Probe map={{ r: onKey }} />);
    fireEvent.keyDown(document, { key: "r", repeat: true });
    expect(onKey).not.toHaveBeenCalled();
  });

  it("swallows everything while disabled and re-arms when enabled", () => {
    const onKey = vi.fn();
    const { rerender } = render(<Probe map={{ r: onKey }} enabled={false} />);
    fireEvent.keyDown(document, { key: "r" });
    expect(onKey).not.toHaveBeenCalled();

    rerender(<Probe map={{ r: onKey }} enabled />);
    fireEvent.keyDown(document, { key: "r" });
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it("runs the latest handler for a binding after a rerender", () => {
    // The map lives in a ref so the listener need not resubscribe; this is what
    // guards that the ref actually stays in sync.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe map={{ r: first }} />);
    rerender(<Probe map={{ r: second }} />);
    fireEvent.keyDown(document, { key: "r" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
