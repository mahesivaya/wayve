# Tasks to Complete — AI-Assisted Task Assignment

Auto-generated summary of the feature broken into 9 tasks.
Full design: [docs/architecture/ai-task-assignment.md](../docs/architecture/ai-task-assignment.md).
Intended owner: **mahesh@fluxze.com** · Status of all: **to_do**

---

## Feature in one line

When a user creates a task on a project, recommend **who should do it** — ranked by **expertise** (who has worked on the relevant code, from public GitHub history) and **availability** (their open tasks + free calendar gaps). AI assists at the edges; a deterministic scoring function makes the call.

---

## The 9 tasks

| # | Task | Priority | Summary |
|---|------|:--------:|---------|
| 1 | Make tasks first-class (`assignee_id` + `project_id`) | 5 | Add real `assignee_id` (FK `users`) and `project_id` (FK `projects`) to the `tasks` table; update create/update API and the task-create UI. Step zero — today's tasks use plain-text assignee and no project link. |
| 2 | GitHub ↔ Wayve identity mapping | 5 | Resolve GitHub commit/PR authors to Wayve members via `github_accounts`. Mapped members are assignable; unmapped contributors surface as reference names (handle only). |
| 3 | GitHub expertise lookup | 4 | For a project's linked public repo, gather contributors + PR authors/reviewers per code path (git blame / PR history). Recency-weight the scores; cache the contributor map per repo/path to respect rate limits. |
| 4 | Task → code-area mapping (AI) | 4 | Map a task's summary/description to likely repo paths/modules via the AI provider; fall back to keyword match against paths, commit messages, and PR titles when the text names no files. |
| 5 | Availability model (load + calendar gaps) | 4 | Compute each candidate's availability from (a) open `to_do`/`in_progress` tasks assigned to them and (b) free time-gaps from the `meetings`/calendar table, over a defined near-term window. |
| 6 | Scoring + `POST /api/tasks/suggest-assignee` | 5 | Deterministic ranking: `expertise × recency − load + availability`. New read-only endpoint takes `{project_id, summary, description}` and returns ranked candidates with raw sub-scores so each recommendation is explainable. |
| 7 | Reference names + visibility scoping | 3 | Surface public GitHub contributors as reference names, scoped strictly to the linked public repo's public history. Show the mapped-vs-unmapped distinction in the UI. |
| 8 | Frontend: assignee suggestion UI | 3 | In the task-create flow, show the ranked assignee list with per-person reasons and reference handles; pre-select the top suggestion but keep it overridable. |
| 9 | AI justification text (why recommended) | 2 | Generate a short natural-language "why recommended" sentence per candidate from the sub-scores (e.g. "4 recent PRs in this area, 1 open task, ~6h free this week"). AI assists here; it never picks the assignee. |

---

## Build order (phased)

1. **Plumbing** — Task 1 (tasks first-class). Nothing else is meaningful without it.
2. **Rule-based v1** — Tasks 2, 3, 5, 6. GitHub authorship + open-task load + calendar gaps. Works day one, no ML corpus.
3. **References** — Task 7.
4. **AI polish** — Tasks 4 and 9 (task→files mapping, justification text).
5. **Later** — semantic "similar work" via embeddings/pgvector, once path/keyword matching hits its ceiling.

---

## Two things to get right

- **Task → files mapping** (Task 4) — the AI's real job; everything downstream depends on it.
- **GitHub ↔ Wayve identity mapping** (Task 2) — only connected members are assignable; others are references.

_Everything else — expertise ranking, load, calendar gaps — is deterministic scoring you can explain to any member whose name appears in a recommendation._
