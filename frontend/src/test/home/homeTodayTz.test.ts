// The home "Today" card asks for the viewer's day: meetings store a zone-less
// date read in the viewer's zone, so the request must carry that zone (the
// server would otherwise use its own UTC clock and show the wrong day's
// meetings near midnight).
import { describe, expect, it, vi, afterEach } from "vitest";

import { getHomeToday } from "../../api/home";

describe("getHomeToday", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the browser's time zone", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Asia/Kolkata",
    } as Intl.ResolvedDateTimeFormatOptions);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await getHomeToday();

    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/api/home/today?tz=Asia%2FKolkata");
  });
});
