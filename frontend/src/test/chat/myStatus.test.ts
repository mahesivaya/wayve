// The one store behind every status picker (account menu, Chat page).
import { beforeEach, describe, expect, it, vi } from "vitest";

const setChatStatus = vi.fn();
vi.mock("../../api/chat", () => ({
  getPresence: vi.fn(async () => [
    { user_id: 3, online: true, last_seen: null, status: "dnd" },
  ]),
  setChatStatus: (s: string) => setChatStatus(s),
}));

import {
  applyMyStatus,
  chooseMyStatus,
  getMyStatus,
  loadMyStatus,
  resetMyStatusForTests,
  subscribeMyStatus,
} from "../../chat/myStatus";

describe("my chat status", () => {
  beforeEach(() => {
    resetMyStatusForTests();
    setChatStatus.mockReset();
  });

  it("seeds from the server", async () => {
    await loadMyStatus(3);
    expect(getMyStatus()).toBe("dnd");
  });

  it("tells every listener, so all pickers stay in step", () => {
    const seen: string[] = [];
    const off = subscribeMyStatus(() => seen.push(getMyStatus()));
    applyMyStatus("away"); // e.g. a push from another device
    applyMyStatus("away"); // no change, no notice
    off();
    applyMyStatus("active");
    expect(seen).toEqual(["away"]);
  });

  it("saves a choice, and puts the old one back if saving fails", async () => {
    setChatStatus.mockResolvedValueOnce(undefined);
    await chooseMyStatus("away");
    expect(setChatStatus).toHaveBeenCalledWith("away");
    expect(getMyStatus()).toBe("away");

    setChatStatus.mockRejectedValueOnce(new Error("offline"));
    await chooseMyStatus("dnd");
    expect(getMyStatus()).toBe("away");
  });
});
