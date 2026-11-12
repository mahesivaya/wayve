// While GitHub is still computing a PR's mergeability (mergeable: null), the PR
// page re-checks it, skipping the proxy cache, until GitHub answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useState } from "react";

const githubJson = vi.fn();
vi.mock("../../github/commitDiffData", () => ({
  githubJson: (url: string) => githubJson(url),
}));

import {
  RECHECK_DELAYS_MS,
  useMergeabilityRecheck,
} from "../../github/useMergeabilityRecheck";

function Probe({ initial }: { initial: boolean | null }) {
  const [mergeable, setMergeable] = useState<boolean | null>(initial);
  useMergeabilityRecheck(
    "/api/github/repos/o/r/pulls/232",
    mergeable === null,
    (m) => setMergeable(m.mergeable)
  );
  return <p data-testid="state">{String(mergeable)}</p>;
}

const flush = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  githubJson.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("useMergeabilityRecheck", () => {
  it("re-checks with a cache-busting param until GitHub answers", async () => {
    githubJson
      .mockResolvedValueOnce({ mergeable: null })
      .mockResolvedValueOnce({ mergeable: false, mergeable_state: "dirty" });
    const { getByTestId } = render(<Probe initial={null} />);

    expect(githubJson).not.toHaveBeenCalled();
    await flush(RECHECK_DELAYS_MS[0]);
    expect(githubJson).toHaveBeenCalledTimes(1);
    expect(githubJson.mock.calls[0][0]).toMatch(
      /^\/api\/github\/repos\/o\/r\/pulls\/232\?fresh=\d+$/
    );
    expect(getByTestId("state").textContent).toBe("null");

    await flush(RECHECK_DELAYS_MS[1]);
    expect(githubJson).toHaveBeenCalledTimes(2);
    expect(getByTestId("state").textContent).toBe("false");

    // Answered: no further re-checks.
    await flush(60_000);
    expect(githubJson).toHaveBeenCalledTimes(2);
  });

  it("gives up after its last attempt", async () => {
    githubJson.mockResolvedValue({ mergeable: null });
    render(<Probe initial={null} />);
    await flush(120_000);
    expect(githubJson).toHaveBeenCalledTimes(RECHECK_DELAYS_MS.length);
  });

  it("does nothing once mergeability is known", async () => {
    render(<Probe initial={true} />);
    await flush(60_000);
    expect(githubJson).not.toHaveBeenCalled();
  });
});
