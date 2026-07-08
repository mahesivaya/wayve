import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjects, suggestAssignee } from "../../api/tasks";
import { clearAuthToken, setAuthToken } from "../../auth/token";

const API_BASE = (import.meta.env.VITE_API_URL ?? "") as string;

function mockFetch(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() {
      return this;
    },
  };
  const fn = vi.fn().mockResolvedValue(response as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("api/tasks assignee suggestion", () => {
  beforeEach(() => {
    setAuthToken("test-jwt");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuthToken();
  });

  it("getProjects GETs /api/projects", async () => {
    const projects = [
      { id: 1, name: "Widgets", github_owner: "acme", github_repo: "widgets" },
    ];
    const fetchMock = mockFetch(200, projects);
    const result = await getProjects();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/projects`);
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    expect(result).toEqual(projects);
  });

  it("suggestAssignee POSTs the project + task text and returns ranked candidates", async () => {
    const payload = {
      project_id: 7,
      summary: "Fix email sync worker",
      description: "sync stalls",
    };
    const responseBody = {
      used_ai: false,
      files: ["src/email/sync.rs"],
      candidates: [
        {
          user_id: 12,
          github_login: "alice",
          display: "alice@acme.com",
          email: "alice@acme.com",
          is_reference_only: false,
          expertise_score: 12,
          commits: 3,
          recent_commits: 3,
          last_activity: "2026-07-01T00:00:00+00:00",
          reason: "3 commits in the relevant file (3 recent)",
        },
        {
          user_id: null,
          github_login: "bob",
          display: "bob",
          email: null,
          is_reference_only: true,
          expertise_score: 1,
          commits: 1,
          recent_commits: 0,
          last_activity: null,
          reason: "1 commit in the relevant file",
        },
      ],
    };
    const fetchMock = mockFetch(200, responseBody);

    const result = await suggestAssignee(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/tasks/suggest-assignee`);
    const request = init as RequestInit;
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body as string)).toEqual(payload);

    // The ranked list comes back best-first, with the assignable member
    // carrying a user_id and the reference-only contributor not.
    expect(result.candidates[0].github_login).toBe("alice");
    expect(result.candidates[0].user_id).toBe(12);
    expect(result.candidates[0].is_reference_only).toBe(false);
    expect(result.candidates[1].is_reference_only).toBe(true);
    expect(result.candidates[1].user_id).toBeNull();
    expect(result.files).toEqual(["src/email/sync.rs"]);
  });
});
