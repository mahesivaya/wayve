# Connecting an organization's GitHub (the Hadal GitHub App)

How an organization brings its own repositories into Code Repo and Projects,
private ones included, and how to set it up on a server. Written for whoever
runs a Hadal server or works on this code.

## What it does

An **organization owner** connects the organization's GitHub once, by installing
the Hadal GitHub App on their GitHub account and choosing which repositories to
share. They can then import those repositories from **Settings → Repositories**
(or the add box in Code Repo), and the whole team browses them in the app: file
tree, commits, pull requests and CI. Nobody else needs a GitHub login.

Each organization reaches only **its own** shared repositories. The server never
uses its own GitHub account (`GITHUB_TOKEN`) to list repos for an organization.

| Account | How repositories get in |
| --- | --- |
| Personal | The user connects their own GitHub (OAuth, `github_oauth.rs`) and imports what that account can see. |
| Organization, connected | The owner installs the GitHub App; private and public repos it was given can be imported or added by URL. |
| Organization, not connected | Public repos only, added by URL. The import list asks the owner to connect. |
| Platform | The shared `GITHUB_TOKEN` account, plus a platform owner's own connected GitHub. |

## Why a GitHub App

A GitHub App is installed per GitHub account. The owner picks the repositories in
GitHub's own screen and can change that choice at any time. The server stores
only the installation id and mints a **one-hour installation token** from the
App's private key when it needs one, so there is no long-lived secret per
organization, and access survives the installing person leaving. A shared
personal access token can't keep tenants apart, and OAuth user tokens die with
the user.

## One-time setup (server operator)

Register one GitHub App for the server. This can't be automated.

GitHub → Settings → Developer settings → **GitHub Apps → New GitHub App**:

| Field | Value |
| --- | --- |
| GitHub App name | Shown to customers on the install screen, e.g. `Hadal`. Its URL slug becomes `GITHUB_APP_SLUG`. |
| Homepage URL | `https://hadalspace.com` |
| Callback URL | `https://hadalspace.com/github/oauth/app/setup` |
| Request user authorization (OAuth) during installation | **On.** Required: the server uses it to check that the person installing can see the installation. |
| Expire user authorization tokens | Either; the token is used once and thrown away. |
| Setup URL | Leave empty (GitHub disables it when the option above is on). |
| Webhook | **Active**. URL `https://hadalspace.com/api/github-app/webhook`, secret = `GITHUB_APP_WEBHOOK_SECRET` (see below). |
| Repository permissions | **Contents: Read-only**, **Metadata: Read-only**, **Pull requests: Read and write** (approve, merge and comment from the app; Read-only if you don't want that), **Actions: Read-only**, **Commit statuses / Checks: Read-only** |
| Subscribe to events | **Pull request**, **Pull request review**, **Pull request review comment** (installation events are always sent) |
| Where can this GitHub App be installed? | **Any account** |

Then, on the App's page:

1. Note the **App ID** and the **Client ID**.
2. **Generate a new client secret.**
3. **Generate a private key** and download the `.pem`.

Set these in the backend's env file (production: `backend/.env.production`):

```
GITHUB_APP_ID=<numeric app id>
GITHUB_APP_SLUG=<app slug>
GITHUB_APP_CLIENT_ID=<client id, Iv1.… or Iv23…>
GITHUB_APP_CLIENT_SECRET=<client secret>
GITHUB_APP_PRIVATE_KEY=<the PEM on one line, with literal \n>
```

For live pull requests, also set the webhook secret, the same random value as
in the App's Webhook section (`openssl rand -hex 32`):

```
GITHUB_APP_WEBHOOK_SECRET=<webhook secret>
```

Without it the webhook endpoint refuses every delivery (503); it never trusts
an unsigned one.

Docker `env_file` can't hold a multi-line value, so either put the key on one
line (`awk 'NF{printf "%s\\n",$0}' app.pem`) or mount the file and set
`GITHUB_APP_PRIVATE_KEY_PATH=/path/in/container/app.pem` instead. All five
values must be set; the boot log prints `github app (org repos): enabled`.

Apply the `github_installations` table from `infra/postgres/init.sql` (it is
idempotent), then restart the backend. The callback lives under `/github/oauth/`,
which nginx already forwards to the backend, so nginx needs no change.

## How an owner connects (the flow)

1. **Settings → Repositories → Import from GitHub → Connect GitHub.** The backend
   (`POST /api/github-app/install`, owner only) stores a one-use state that names
   the organization and the owner, and returns the App's install URL.
2. **On GitHub**, the owner picks the account (often their GitHub organization)
   and the repositories, and approves.
3. GitHub sends the browser to `/github/oauth/app/setup` with `installation_id`,
   `state` and `code`. The backend:
   - spends the state, and checks in the database that the user is still the
     owner of that organization;
   - exchanges `code` for the installing user's token and checks that
     `GET /user/installations` lists this installation, so nobody can claim
     another account's installation id;
   - refuses an installation already connected to another organization;
   - records `github_installations` and returns to Settings with
     `#github_app=connected`, or `#github_app_error=<reason>`.
4. **Import.** The import list now shows the installation's repositories, and
   adding by URL accepts a private repo the App was given.

If the person installing can't install on their GitHub organization, GitHub sends
a request to that organization's owners instead (`setup_action=request`). The page
says so; the owner connects once it's approved.

**Choose repositories** (shown to the owner) opens GitHub's page for the
installation, where repositories are added or removed and the App uninstalled.
**Disconnect** only forgets the installation in Hadal.

## Permissions

Connecting and disconnecting are owner-only (`rbac::require_owner`, organization
scope). Status (`GET /api/github-app/status`) is open to members; only the owner
gets the GitHub settings link. Reading a repo still goes through the existing
Code Repo gates: the repo must be linked to an organization project, the role
must have Code Repo enabled, and restricted roles need a per-repo grant.

## How it works under the hood

- **Table.** `github_installations`: one row per organization
  (`organization_id` primary key, `installation_id` unique, `account_login`,
  `account_type`, `installed_by`). Linked repos stay on `projects.github_owner` /
  `github_repo`, as before.
- **Tokens** (`github_app.rs`). An RS256 App JWT (from the private key, valid nine
  minutes) is exchanged for an installation token via
  `POST /app/installations/{id}/access_tokens`, cached for 50 minutes.
- **Proxy** (`github_proxy.rs`). For an organization caller with an installation,
  `effective_github_token`, `write_github_token` and the read proxy use the
  installation token. Reads are cached under `org:<id>:`, so one organization's
  private data is never served to another; the cache is cleared when the
  connection changes. A 401/403/404 from the installation falls back to the
  shared token, for public repos added by URL that the App wasn't given.
- **Lists.** `/api/github-importable-repos` returns the installation's repos for a
  connected organization and `connected: false` otherwise. `/api/projects/visible`
  returns an organization's linked repos, never the shared token's account.
- **Adding by URL** (`workspace/handler.rs`). A connected organization validates
  with its installation token and may add private repos; otherwise public only.
- **Frontend.** `github/AddRepoForms.tsx` switches the connect, disconnect and
  "Choose repositories" controls between personal OAuth and the App.

## Live pull requests (webhook)

`POST /api/github-app/webhook` (`github_app_webhook.rs`) receives the App's
deliveries, each checked against GitHub's `X-Hub-Signature-256` HMAC.

- **Pull request activity** (`pull_request`, `pull_request_review`,
  `pull_request_review_comment`) clears the proxy's cached copy of that repo,
  maps the delivery's installation to its organization, and pushes
  `{"type":"github:pulls","repo","number","action","event"}` to everyone who
  can see the repo: the connected organization's owner and admins, or members
  granted it, and platform staff (owners and admins, or members granted it),
  whose Code & reviews can open any repo. The frame
  rides the same per-user WebSocket as chat and email (`chat::fan_out_user`).
- **On the client**, `useChatSocket` hands `github:` frames to
  `github/githubLiveEvents.ts` instead of treating them as chat messages, and an
  open Code & reviews page reloads its pull requests (list, counts, and the open
  PR if it changed) half a second after a burst settles.
- **An uninstall on GitHub** (`installation` `deleted`) removes the
  organization's `github_installations` row, so it shows as not connected.

## Limitations

- An installation serves one Hadal organization.
- Only pull request activity is pushed live; other changes on GitHub (commits,
  CI runs) show up when the app next reads them, within the proxy's 60-second
  cache.
