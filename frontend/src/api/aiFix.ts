// The AI-fix pipeline, shared by Tickets and User Stories. Both boards expose an
// identical set of endpoints under their own collection prefix, so the whole
// client is one factory parameterised by that prefix.
//
// Flow: start() dispatches CI → CI posts the diff + changed files back → the
// reviewer reads the diff, optionally edits the files, then drives
// commit() → push() → openPr(), each idempotent on the backend.
import { apiFetchJson } from "./client";

export type AiFixStatus =
  | "running"
  | "ready"
  | "committed"
  | "pushed"
  | "pr_opened"
  | "no_change"
  | "error";

// One changed file. `content` is base64 so arbitrary bytes survive JSON — this,
// not the diff, is what the Commit step turns into Git blobs.
export type AiFixFile = {
  path: string;
  content: string;
  deleted: boolean;
};

export type AiFixState = {
  status: AiFixStatus | null;
  diff: string | null;
  files: AiFixFile[];
  commit_sha: string | null;
  branch: string | null;
  pr_url: string | null;
};

export type AiFixStartResult = {
  dispatched?: boolean;
  reused_fix_from: number | null;
};

export type AiFixApi = {
  getState: (id: number) => Promise<AiFixState>;
  start: (id: number) => Promise<AiFixStartResult>;
  saveEdits: (
    id: number,
    files: AiFixFile[],
    diff?: string
  ) => Promise<{ saved: boolean }>;
  commit: (id: number) => Promise<{ commit_sha: string }>;
  push: (id: number) => Promise<{ branch: string }>;
  openPr: (id: number) => Promise<{ pr_url: string }>;
};

/// Build the client for one collection — "workspace-tickets" or "user-stories".
export function makeAiFixApi(collection: string): AiFixApi {
  const base = (id: number) => `/api/${collection}/${id}`;
  const post = <T,>(url: string, body?: unknown) =>
    apiFetchJson<T>(url, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    // `files` predates this client, so tolerate a backend that omits it rather
    // than rendering `undefined.map` in the editor.
    getState: async (id) => {
      const s = await apiFetchJson<AiFixState>(`${base(id)}/ai-fix`);
      return { ...s, files: s.files ?? [] };
    },
    start: (id) => post<AiFixStartResult>(`${base(id)}/ai-fix`),
    saveEdits: (id, files, diff) =>
      post<{ saved: boolean }>(`${base(id)}/ai-fix-edit`, { files, diff }),
    commit: (id) => post<{ commit_sha: string }>(`${base(id)}/ai-fix-commit`),
    push: (id) => post<{ branch: string }>(`${base(id)}/ai-fix-push`),
    openPr: (id) => post<{ pr_url: string }>(`${base(id)}/ai-fix-open-pr`),
  };
}

export const ticketAiFix = makeAiFixApi("workspace-tickets");
export const storyAiFix = makeAiFixApi("user-stories");
