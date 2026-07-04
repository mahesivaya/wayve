# Repository / project access

How repositories appear on the **Projects page** (`/projects`), who can see which,
and the target design for letting each organization connect **its own** repository.

## Today (implemented)

### Where repos come from
The Projects page and the Code Repo viewer are backed by a **single platform-wide
GitHub token** (`GITHUB_TOKEN`), proxied through `backend/.../github_proxy.rs`
(`/api/github/...`). Every repo that token can see is, in principle, visible to
the app. Repos are therefore **not partitioned by organization** — there is one
shared repo pool, not one per org.

### Per-user access (the scoping mechanism)
Because the token is shared, visibility is scoped **per user** via a grant table:

- **Table** `member_project_access(user_id, repo_full_name, granted_by, …)` —
  one row grants one user visibility of one repo, keyed by GitHub `full_name`
  (`owner/name`). Defined in `infra/postgres/init.sql` and mirrored in
  `startup.rs` (auto-creates on boot).
- **Grant/revoke** — on the platform member page
  (`/platform/members/:id` → "Projects access" card): `GET/PUT
  /api/platform/members/{user_id}/projects` (`routes/user/members.rs`), gated by
  `MembersRead` / `MembersManage` + `Scope::Platform`, audited as
  `projects_access_change`.
- **Enforcement** — the Projects page calls `GET /api/projects/visible`
  (`github_proxy.rs::visible_projects`), which decides server-side:
  - **Unrestricted** (sees every repo): platform `owner/super_admin/admin`, and —
    for now — all organization and personal accounts.
  - **Restricted** (sees only granted repos): **non-admin platform members**.
  The filter runs on the server (not the client) so a restricted member can't
  bypass it by calling the proxy directly.

### Limitations
- Repos are global to the shared token; the grant list is what scopes them.
- Only the **platform** member page manages grants today (no org-scope UI).
- SSO/passwordless members are unaffected here (this is visibility, not keys).

## Target (design — not yet implemented)

Goal: **an organization/enterprise owner connects their own GitHub repository,
visible only to their team** — real per-org partitioning instead of the shared
token.

### Model
- Per-org GitHub connection: either an **owner-supplied token** (a fine-grained
  PAT / OAuth token stored encrypted per org, like `org_sso_configs` stores an
  encrypted client secret) or a **GitHub App installation** mapped to the org.
- An **org → repo** mapping so an org's members only ever see that org's repos —
  extend the existing `projects` table (`github_owner` / `github_repo` columns,
  populated today via `workspace/handler.rs::link_project_repo`) to become the
  authoritative per-org repo set, and resolve repos through the **org's** token
  instead of the shared one.
- `member_project_access` then narrows *within* an org (optional per-member
  subset), exactly as it does platform-side today.

### How an org/enterprise owner adds a complete repository (target flow)
1. **Settings → Repositories (org owner only).** New surface under org settings
   (mirror the SSO settings page pattern).
2. **Connect GitHub.** Either install the GitHub App on the org's GitHub org, or
   paste a fine-grained PAT scoped to the repos to share (read contents,
   metadata, pull requests). Store it **encrypted** (AES-256-GCM, like the SSO
   client secret) keyed by `organization_id`.
3. **Add a repository.** Enter the repo (`owner/name`) or pick from the list the
   connection can see; validate it resolves via the org's token; persist an
   org→repo row (extend `projects`).
4. **Team visibility.** Every member of that org now sees the repo on their
   Projects page (resolved via the org token). Optionally restrict to a subset of
   members via `member_project_access`.
5. **Remove / rotate.** Owner can disconnect the token/app (revokes visibility
   for the whole org) or remove a single repo.

### Build notes
- Reuse: `wayve_security::encryption` for the per-org token; the `github_proxy`
  request/`list_repos` plumbing (parameterize it to take a token + base rather
  than only the shared `GITHUB_TOKEN`); the `projects` table + `link_project_repo`
  validation; `org_sso_configs` as the pattern for an encrypted per-org secret.
- Gate all connect/add/remove endpoints on `rbac::require_owner` (org owner).
- Audit connect / add-repo / remove-repo as privilege changes.
