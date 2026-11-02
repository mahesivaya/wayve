// Autosave for half-written emails: when a save happens, what it writes, and that
// nothing is lost or left behind when the composer closes, the email changes, a
// save fails, or the message turns out to be one the server mustn't hold.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { DraftContent, EmailDraft } from "../../api/emailDrafts";

const api = vi.hoisted(() => ({
  createEmailDraft: vi.fn(),
  updateEmailDraft: vi.fn(),
  deleteEmailDraft: vi.fn(),
}));
vi.mock("../../api/emailDrafts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

import { useDraftAutosave } from "../../emails/useDraftAutosave";
import {
  EMAIL_DRAFT_DELETED_EVENT,
  EMAIL_DRAFT_SAVED_EVENT,
} from "../../emails/useEmailDrafts";

const content = (body: string): DraftContent => ({
  to: "bob@x.com",
  cc: "",
  bcc: "",
  subject: "Hello",
  body,
});

const saved = (id: number, body: string): EmailDraft => ({
  ...content(body),
  id,
  kind: "compose",
  source_email_id: null,
  account_id: 7,
  created_at: "2026-11-02T00:00:00Z",
  updated_at: "2026-11-02T00:00:00Z",
});

type Props = Parameters<typeof useDraftAutosave>[0];
const props = (body: string, over: Partial<Props> = {}): Props => ({
  kind: "compose",
  sourceEmailId: null,
  accountId: 7,
  content: content(body),
  hasContent: body !== "",
  enabled: true,
  ...over,
});

const mount = (initial: Props) =>
  renderHook((p: Props) => useDraftAutosave(p), { initialProps: initial });

// Past the debounce, and then the queued request.
const settle = (ms = 1500) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  api.createEmailDraft.mockReset();
  api.updateEmailDraft.mockReset();
  api.deleteEmailDraft.mockReset();
  api.createEmailDraft.mockImplementation(async (d: DraftContent) =>
    saved(1, d.body)
  );
  api.updateEmailDraft.mockImplementation(async (id: number, d: DraftContent) =>
    saved(id, d.body)
  );
  api.deleteEmailDraft.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useDraftAutosave", () => {
  it("waits for typing to stop, then creates one draft", async () => {
    const { result, rerender } = mount(props("h"));
    await settle(1000);
    rerender(props("he"));
    await settle(1000);
    rerender(props("hello"));
    await settle(1000);
    expect(api.createEmailDraft).not.toHaveBeenCalled();

    await settle(500);
    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);
    expect(api.createEmailDraft.mock.calls[0][0]).toMatchObject({
      kind: "compose",
      body: "hello",
      account_id: 7,
    });
    expect(result.current.status).toBe("saved");
  });

  it("updates the same draft afterwards, and skips unchanged content", async () => {
    const { rerender } = mount(props("one"));
    await settle();
    rerender(props("two"));
    await settle();
    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);
    expect(api.updateEmailDraft).toHaveBeenCalledTimes(1);
    expect(api.updateEmailDraft.mock.calls[0][0]).toBe(1);

    rerender(props("two"));
    await settle(5000);
    expect(api.updateEmailDraft).toHaveBeenCalledTimes(1);
  });

  it("saves nothing while there's nothing worth keeping", async () => {
    mount(props("", { hasContent: false }));
    await settle(5000);
    expect(api.createEmailDraft).not.toHaveBeenCalled();
    expect(api.deleteEmailDraft).not.toHaveBeenCalled();
  });

  it("deletes the draft when the text is cleared", async () => {
    const { rerender } = mount(props("text"));
    await settle();
    rerender(props(""));
    await settle();
    expect(api.deleteEmailDraft).toHaveBeenCalledWith(1, { keepalive: false });
  });

  it("saves unsaved text on unmount, leaving the page", async () => {
    const { unmount } = mount(props("typed just now"));
    unmount();
    await settle(0);
    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);
    expect(api.createEmailDraft.mock.calls[0][0].body).toBe("typed just now");
  });

  it("saves unsaved text when the tab goes away, with keepalive", async () => {
    mount(props("closing"));
    window.dispatchEvent(new Event("pagehide"));
    await settle(0);
    expect(api.createEmailDraft.mock.calls[0][1]).toEqual({ keepalive: true });
  });

  it("saves pending text when the composer closes, then stops", async () => {
    const { rerender } = mount(props("hi", { enabled: true }));
    rerender(props("hi", { enabled: false }));
    await settle(0);
    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);

    rerender(props("hi again", { enabled: false }));
    await settle(5000);
    expect(api.updateEmailDraft).not.toHaveBeenCalled();
  });

  it("files pending text under the email it was written for", async () => {
    const reply = (id: number, body: string) =>
      props(body, { kind: "reply", sourceEmailId: id });
    const { rerender } = mount(reply(10, "about ten"));
    rerender(reply(20, ""));
    await settle();

    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);
    expect(api.createEmailDraft.mock.calls[0][0]).toMatchObject({
      source_email_id: 10,
      body: "about ten",
    });
    // Twenty starts clean: nothing deleted, and its own save creates its own draft.
    expect(api.deleteEmailDraft).not.toHaveBeenCalled();
    rerender(reply(20, "about twenty"));
    await settle();
    expect(api.createEmailDraft).toHaveBeenCalledTimes(2);
    expect(api.updateEmailDraft).not.toHaveBeenCalled();
  });

  it("never files the previous email's text under the next one", async () => {
    const reply = (id: number, body: string, enabled = true) =>
      props(body, { kind: "reply", sourceEmailId: id, enabled });
    const { rerender } = mount(reply(10, "about ten"));
    // The email changes a tick before the composer is cleared and closed.
    rerender(reply(20, "about ten"));
    rerender(reply(20, "", false));
    await settle(5000);

    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);
    expect(api.createEmailDraft.mock.calls[0][0].source_email_id).toBe(10);
  });

  it("nor when that text just sits there", async () => {
    const reply = (id: number, body: string) =>
      props(body, { kind: "reply", sourceEmailId: id });
    const { rerender } = mount(reply(10, "about ten"));
    await settle();
    rerender(reply(20, "about ten"));
    await settle(5000);
    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);
    expect(api.updateEmailDraft).not.toHaveBeenCalled();

    // Typing on the new email is a draft of its own again.
    rerender(reply(20, "about twenty"));
    await settle();
    expect(api.createEmailDraft).toHaveBeenCalledTimes(2);
    expect(api.createEmailDraft.mock.calls[1][0].source_email_id).toBe(20);
  });

  it("runs requests in order, so a save uses the id its create returned", async () => {
    let finishCreate: (d: EmailDraft) => void = () => {};
    api.createEmailDraft.mockImplementation(
      () => new Promise((resolve) => (finishCreate = resolve))
    );
    const { rerender } = mount(props("one"));
    await settle();
    rerender(props("two"));
    await settle();
    expect(api.updateEmailDraft).not.toHaveBeenCalled();
    expect(api.createEmailDraft).toHaveBeenCalledTimes(1);

    finishCreate(saved(42, "one"));
    await settle(0);
    expect(api.updateEmailDraft.mock.calls[0][0]).toBe(42);
    expect(api.updateEmailDraft.mock.calls[0][1].body).toBe("two");
  });

  it("recreates a draft deleted elsewhere rather than losing the text", async () => {
    const { rerender } = mount(props("one"));
    await settle();
    api.updateEmailDraft.mockResolvedValue(null);
    api.createEmailDraft.mockImplementation(async (d: DraftContent) =>
      saved(2, d.body)
    );
    rerender(props("two"));
    await settle();
    expect(api.createEmailDraft).toHaveBeenCalledTimes(2);
    expect(api.createEmailDraft.mock.calls[1][0].body).toBe("two");
  });

  it("reports a failed save and retries when the composer closes", async () => {
    api.createEmailDraft.mockRejectedValueOnce(new Error("down"));
    const { result, unmount } = mount(props("precious"));
    await settle();
    expect(result.current.status).toBe("error");

    unmount();
    await settle(0);
    expect(api.createEmailDraft).toHaveBeenCalledTimes(2);
    expect(api.createEmailDraft.mock.calls[1][0].body).toBe("precious");
  });

  it("carries on from an adopted draft without re-saving it", async () => {
    const draft = saved(9, "restored");
    const { result, rerender } = mount(
      props("", { hasContent: false, enabled: false })
    );
    act(() => result.current.adopt(draft));
    rerender(props("restored"));
    await settle(5000);
    expect(api.createEmailDraft).not.toHaveBeenCalled();
    expect(api.updateEmailDraft).not.toHaveBeenCalled();

    rerender(props("restored, edited"));
    await settle();
    expect(api.updateEmailDraft.mock.calls[0][0]).toBe(9);
    expect(api.createEmailDraft).not.toHaveBeenCalled();
  });

  it("discard cancels the pending save and deletes the draft", async () => {
    const { result, rerender, unmount } = mount(props("one"));
    await settle();
    rerender(props("two"));
    await act(async () => {
      await result.current.discard();
    });
    expect(api.deleteEmailDraft).toHaveBeenCalledTimes(1);
    unmount();
    await settle(5000);
    expect(api.updateEmailDraft).not.toHaveBeenCalled();
  });

  it("discard waits for a create in flight, so nothing is left behind", async () => {
    let finishCreate: (d: EmailDraft) => void = () => {};
    api.createEmailDraft.mockImplementation(
      () => new Promise((resolve) => (finishCreate = resolve))
    );
    const { result } = mount(props("one"));
    await settle();
    void result.current.discard();
    await settle(0);
    expect(api.deleteEmailDraft).not.toHaveBeenCalled();

    finishCreate(saved(5, "one"));
    await settle(0);
    expect(api.deleteEmailDraft).toHaveBeenCalledWith(5, { keepalive: false });
  });

  describe("sensitive messages", () => {
    it("never sends the text", async () => {
      const { unmount } = mount(props("secret", { sensitive: true }));
      await settle(5000);
      unmount();
      await settle(0);
      expect(api.createEmailDraft).not.toHaveBeenCalled();
    });

    it("turning it on drops the pending save and deletes the copy", async () => {
      const { rerender, unmount } = mount(props("one"));
      await settle();
      rerender(props("one, now secret"));
      rerender(props("one, now secret", { sensitive: true }));
      await settle(5000);
      expect(api.updateEmailDraft).not.toHaveBeenCalled();
      expect(api.deleteEmailDraft).toHaveBeenCalledTimes(1);
      unmount();
      await settle(0);
      expect(api.updateEmailDraft).not.toHaveBeenCalled();
    });

    it("turning it off starts saving again", async () => {
      const { rerender } = mount(props("text", { sensitive: true }));
      await settle();
      rerender(props("text", { sensitive: false }));
      await settle();
      expect(api.createEmailDraft).toHaveBeenCalledTimes(1);
    });
  });

  it("tells the drafts list about saves and deletes", async () => {
    const heard: string[] = [];
    const onSaved = () => heard.push("saved");
    const onDeleted = () => heard.push("deleted");
    window.addEventListener(EMAIL_DRAFT_SAVED_EVENT, onSaved);
    window.addEventListener(EMAIL_DRAFT_DELETED_EVENT, onDeleted);
    const { result } = mount(props("one"));
    await settle();
    await act(async () => {
      await result.current.discard();
    });
    window.removeEventListener(EMAIL_DRAFT_SAVED_EVENT, onSaved);
    window.removeEventListener(EMAIL_DRAFT_DELETED_EVENT, onDeleted);
    expect(heard).toEqual(["saved", "deleted"]);
  });
});
