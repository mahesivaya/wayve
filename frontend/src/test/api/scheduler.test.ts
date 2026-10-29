import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateGetCache } from "../../api/client";
import { createMeetingLinkApi } from "../../api/scheduler";
import { clearAuthToken } from "../../auth/token";

function textResponse(body: string, status: number) {
  return new Response(body, { status });
}

describe("createMeetingLinkApi", () => {
  beforeEach(() => {
    clearAuthToken();
    invalidateGetCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the join URL on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ join_url: "https://zoom.us/j/1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(createMeetingLinkApi()).resolves.toEqual({
      join_url: "https://zoom.us/j/1",
    });
  });

  // apiFetch used to throw on the 503 before this check ran, so an
  // unconfigured server showed "try again" instead of "not set up".
  it("reports not_configured when Zoom is not set up (503)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        textResponse("Video meetings are not configured on this server.", 503)
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createMeetingLinkApi()).rejects.toThrow("not_configured");
    // Only the meeting-link request: an expected 503 is not sent to the
    // central error log.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a generic failure when Zoom rejects the request (502)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          textResponse("Could not create a meeting link. Please try again.", 502)
        )
    );

    await expect(createMeetingLinkApi()).rejects.toThrow();
    await expect(createMeetingLinkApi()).rejects.not.toThrow("not_configured");
  });
});
