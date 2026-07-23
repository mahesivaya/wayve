---
name: fix-ticket
description: >-
  Implement a fix for a Workspace ticket / reported bug and prepare it for a pull
  request. Use when asked to fix a ticket, resolve a reported bug, or act on a
  ticket number + title + description (e.g. from the AI-fix CI workflow). Reads
  the repo docs, makes the change, and self-verifies before the PR is opened.
---

# Fixing a ticket

You are implementing a fix for one Workspace ticket in this repository. You are
given the ticket's number, title, and description, and sometimes a summary +
commit SHA of how a **similar past ticket** was fixed — use that as a worked
example (inspect that commit's diff to see the pattern), not a literal copy.

## Procedure

1. **Understand the codebase and the ticket.** Read the root `CLAUDE.md` (repo
   layout, commands, conventions) and the relevant files under `docs/architecture/`
   for the area the ticket touches (auth, chat, email, tickets, billing, etc.).
   If a past-fix commit SHA was provided, read its diff first for guidance.
2. **Locate the root cause**, then make the **smallest correct change** that fixes
   it. Match the surrounding code's style, error handling, and conventions
   (production code propagates errors with `?`/`match`; no `unwrap`/`expect`).
3. **Self-verify — every command must pass before you finish.** These don't need
   a database and are the agent's gate (the PR's CI re-runs the full suite,
   including DB-backed tests, as the enforced gate):
   - Backend (from `backend/`): `cargo fmt --all -- --check`,
     `cargo clippy -- -D warnings`, `cargo build`.
   - Frontend (from `frontend/`): `npx tsc --noEmit`, `npm test`.
   Fix anything that fails and re-run until all are green. If you cannot get them
   green, stop and explain what remains — do not hand off a broken change.
4. **Summarize** what you changed and why in 2–4 sentences (this becomes the PR
   body and the ticket's stored resolution summary).

## Constraints

- Stay in scope: fix only what the ticket describes; don't refactor unrelated code.
- Follow the repo's Conventional Commits (`fix(scope): summary`); **no**
  `Co-Authored-By` trailer (see `CLAUDE.md`).
- Do not edit `infra/postgres/init.sql` schema unless the ticket truly requires it.
- **Commit your change** on the current branch as one Conventional Commit
  (`fix(scope): summary`, no `Co-Authored-By`) once the checks pass — the workflow
  pushes that commit's branch and posts its diff back for in-app review. If you
  make no commit, the pipeline reports "no change" for the ticket.
- You do **not** open the PR. The owner reviews your diff on the ticket page and
  clicks "Commit & push" to open it.
