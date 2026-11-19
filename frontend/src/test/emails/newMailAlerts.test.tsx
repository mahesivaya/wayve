// New-mail alerts: what is already in the inbox is never announced, mail that
// arrives on top is, and a history backfill or a mailbox being connected is not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const getEmails = vi.hoisted(() => vi.fn());
vi.mock("../../api/email", () => ({ getEmails }));

const raiseArrivalAlert = vi.hoisted(() => vi.fn());
vi.mock("../../components/messageAlerts", () => ({ raiseArrivalAlert }));

import { EMAILS_SYNCED_EVENT } from "../../emails/useEmailLiveRefresh";
import { useNewMailAlerts } from "../../emails/useNewMailAlerts";

type Row = {
  id: number;
  sender: string;
  subject: string;
  is_read: boolean;
};
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id,
  sender: `Sender ${id} <s${id}@test.local>`,
  subject: `Subject ${id}`,
  is_read: false,
  ...over,
});

let inbox: Row[] = [];
const openMail = vi.fn();

// Mount with `inbox` as it stands, then let the first (silent) load finish.
const mount = async () => {
  renderHook(() => useNewMailAlerts(1, openMail));
  await waitFor(() => expect(getEmails).toHaveBeenCalledTimes(1));
};

// The server announces a sync; wait for the recheck it triggers.
const sync = async (next: Row[]) => {
  inbox = next;
  const before = getEmails.mock.calls.length;
  window.dispatchEvent(new CustomEvent(EMAILS_SYNCED_EVENT));
  await waitFor(() => expect(getEmails.mock.calls.length).toBe(before + 1));
  await Promise.resolve();
};

describe("useNewMailAlerts", () => {
  beforeEach(() => {
    getEmails.mockReset();
    getEmails.mockImplementation(async () => ({
      emails: inbox,
      hasMore: false,
      total: null,
    }));
    raiseArrivalAlert.mockReset();
    openMail.mockReset();
    inbox = [row(2), row(1)];
  });
  afterEach(() => cleanup());

  it("reads the inbox and stays quiet about what is already there", async () => {
    await mount();
    expect(getEmails).toHaveBeenCalledWith({ folder: "inbox" });
    await sync([row(2), row(1)]);
    expect(raiseArrivalAlert).not.toHaveBeenCalled();
  });

  it("announces one new email by its sender and subject, once", async () => {
    await mount();
    await sync([row(3), row(2), row(1)]);
    expect(raiseArrivalAlert).toHaveBeenCalledTimes(1);
    const [kind, alert] = raiseArrivalAlert.mock.calls[0];
    expect(kind).toBe("emails");
    expect(alert).toMatchObject({
      title: "Sender 3",
      body: "Subject 3",
      tag: "mail:3",
    });
    alert.onClick();
    expect(openMail).toHaveBeenCalledTimes(1);

    // The same mail on the next sync is no longer new.
    await sync([row(3), row(2), row(1)]);
    expect(raiseArrivalAlert).toHaveBeenCalledTimes(1);
  });

  it("groups several arrivals into one alert", async () => {
    await mount();
    await sync([row(4), row(3), row(2), row(1)]);
    expect(raiseArrivalAlert).toHaveBeenCalledTimes(1);
    expect(raiseArrivalAlert.mock.calls[0][1]).toMatchObject({
      title: "2 new emails",
      body: "Sender 4, Sender 3",
    });
  });

  it("skips mail that is already read", async () => {
    await mount();
    await sync([row(3, { is_read: true }), row(2), row(1)]);
    expect(raiseArrivalAlert).not.toHaveBeenCalled();
  });

  it("skips older mail a backfill adds below what was already there", async () => {
    await mount();
    await sync([row(2), row(1), row(9), row(8)]);
    expect(raiseArrivalAlert).not.toHaveBeenCalled();
  });

  it("skips a mailbox being connected, which brings in mail in bulk", async () => {
    await mount();
    const bulk = Array.from({ length: 11 }, (_, i) => row(100 - i));
    await sync([...bulk, row(2), row(1)]);
    expect(raiseArrivalAlert).not.toHaveBeenCalled();
    // And none of it counts as new afterwards.
    await sync([row(200), ...bulk, row(2), row(1)]);
    expect(raiseArrivalAlert).toHaveBeenCalledTimes(1);
    expect(raiseArrivalAlert.mock.calls[0][1].tag).toBe("mail:200");
  });

  it("does nothing when signed out", async () => {
    renderHook(() => useNewMailAlerts(undefined, openMail));
    window.dispatchEvent(new CustomEvent(EMAILS_SYNCED_EVENT));
    await Promise.resolve();
    expect(getEmails).not.toHaveBeenCalled();
  });
});
