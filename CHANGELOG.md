# Changelog

All notable changes to this project are documented here.
This file is generated from Conventional Commits by [git-cliff](https://git-cliff.org).

## [5.4.3](https://github.com/mahesivaya/wayve/releases/tag/v5.4.3) - 2026-07-03

### 🐛 Bug Fixes

- **github:** Auto-load a commit's diff when its row is expanded but unloaded

### 🧹 Maintenance

- **changelog:** Update for v5.4.1 [skip ci]

## [5.4.1](https://github.com/mahesivaya/wayve/releases/tag/v5.4.1) - 2026-07-03

### 🚀 Features

- **github:** Per-file expand/collapse for commit and PR diffs

### 🧹 Maintenance

- **changelog:** Update for v5.3.1 [skip ci]

## [5.3.1](https://github.com/mahesivaya/wayve/releases/tag/v5.3.1) - 2026-07-02

### 🚀 Features

- **sso:** Add collapsible Google Workspace setup guide to SSO page
- **sso:** Surface SSO config in Settings and improve the config page

### 🧹 Maintenance

- **changelog:** Update for v5.3.0 [skip ci]

## [5.3.0](https://github.com/mahesivaya/wayve/releases/tag/v5.3.0) - 2026-07-02

### 🚀 Features

- **emails:** Let the platform's primary owner connect their own mailbox

### 🧹 Maintenance

- **changelog:** Update for v5.2.1 [skip ci]

## [5.2.1](https://github.com/mahesivaya/wayve/releases/tag/v5.2.1) - 2026-07-02

### 🐛 Bug Fixes

- **auth:** Normalize email on register to prevent login lockout and case-variant duplicates

### 🧹 Maintenance

- **changelog:** Update for v5.2.0 [skip ci]

## [5.2.0](https://github.com/mahesivaya/wayve/releases/tag/v5.2.0) - 2026-07-02

### 🚀 Features

- **auth:** Require email verification code for business signup

### 🧹 Maintenance

- **changelog:** Update for v5.1.0 [skip ci]

## [5.1.0](https://github.com/mahesivaya/wayve/releases/tag/v5.1.0) - 2026-07-02

### 🧹 Maintenance

- **brand:** Rename Wayve to Fluxze in verification email and getting-started docs
- **changelog:** Update for v5.0.0 [skip ci]

## [5.0.0](https://github.com/mahesivaya/wayve/releases/tag/v5.0.0) - 2026-07-02

### 🚀 Features

- **auth:** Email verification on personal signup via 6-digit code
- **emails:** Let an organization's primary owner connect their own mailbox
- **email:** Gmail instant new-mail via users.watch + Cloud Pub/Sub push
- **org:** Rename 'Handle' label to 'Username' in create-account form
- **aichat:** Center composer when empty, match input to page color
- **home:** Replace '+ Add task' with 'Open tasks' link on dashboard
- **emails:** Also hide the accounts sidebar until a mailbox is connected
- **emails:** Hide inbox toolbar and folder tabs until a mailbox is connected
- **emails:** Attachments in compose, reply, and forward
- **github:** Owner can merge a pull request from the in-app code repo
- **ai:** Surface the real provider on the assistant + platform-owner AI config
- **github:** Owner can approve a pull request from the in-app code repo
- **emails:** GitHub PRs tab in org/platform inline folder tabs
- **emails:** GitHub PRs inbox filter for PR-related mail
- **github:** Email a notification when a new PR is opened
- **github:** Show total commit count on the Commits tab
- **emails:** Reconnect Gmail button when a dead token blocks body load
- **billing:** Self-serve Enterprise checkout instead of contact sales
- **github:** Paginate the Commits tab (50/page, Prev/Next)
- **github:** Restrict the in-app Pull Requests view to scope owners
- **mcp:** Centralize MCP management — toggle, settings, connected badge
- **mcp:** Pick-a-server connection blocks for the Connect-MCP panel
- **billing:** Rebrand plan tiers + single plan-name catalog
- **ai:** Enterprise-owner-selectable AI provider + usage page
- **db:** Enforce RLS on chat (RLS phase 2 — chat unit)
- **github:** Two-column PR detail to match the product mockup
- **db:** Enforce RLS on emails (RLS phase 2 — emails unit)
- **github:** Two-column PR detail to match the product mockup
- **github:** PR detail view with read-only discussion
- **db:** Enforce Row-Level Security on user-private tables (RLS phase 2)
- **org:** Platform-owner enterprise org provisioning
- **integrations:** Friendlier Connect-MCP with per-client setup picker
- **demo:** Public Book-a-Demo lead form
- **logs:** Show User Logs and Audit Logs tables in tabs
- **audit:** Prune audit_logs on a configurable retention window
- **db:** Tag tenant-owned rows with organization_id (RLS phase 1)

### 🐛 Bug Fixes

- **auth:** Complete Google login even when mailbox is linked to another user
- **emails:** Trash Gmail messages on delete instead of permanent-delete
- **emails:** Show INBOX/SENT-labelled mail (incl. self-sends) in those folders
- **emails:** Make compose Attach button + note readable on dark modal
- **settings:** Let settings pages scroll when content exceeds the viewport

### 🧹 Maintenance

- Gitignore the updated OAuth client_secret file
- **org:** Stop enforcing domain ownership at account creation
- **members:** Reduce member list row height
- **members:** Reduce member list row height
- Remove PR-approve/merge smoke-test files
- Smoke file for PR-approve verification (round 2)
- Smoke file for PR-approve verification
- **github:** Commits page size 50 -> 25
- **code-repo:** Add a dashboard overview
- **ai:** Add an FAQ for the enterprise AI provider
- **docs:** Note recommended editor settings
- **github:** Fix owner_links_repo proxy test to seed code_repo for members
- **dev:** Poll for file changes in the Docker dev container so HMR works on macOS

## [4.1.1](https://github.com/mahesivaya/wayve/releases/tag/v4.1.1) - 2026-06-24

### 🚀 Features

- **org:** Real DNS domain verification, gated to business/enterprise owners

## [4.1.0](https://github.com/mahesivaya/wayve/releases/tag/v4.1.0) - 2026-06-24

### 🚀 Features

- **org:** Add enterprise-owner Domain page with simple verify-ownership flow

## [4.0.1](https://github.com/mahesivaya/wayve/releases/tag/v4.0.1) - 2026-06-24

### 🚀 Features

- **chat:** Include active channels in the sidebar Recent list

### 🐛 Bug Fixes

- **chat:** Keep main composer beside the thread panel and align the two inputs

## [4.0.0](https://github.com/mahesivaya/wayve/releases/tag/v4.0.0) - 2026-06-24

### 🚀 Features

- **chat:** Make the thread panel divider draggable to resize
- **mcp:** Connect MCP servers so the AI can read enterprise/platform systems

## [3.5.0](https://github.com/mahesivaya/wayve/releases/tag/v3.5.0) - 2026-06-24

### 🐛 Bug Fixes

- **settings:** Reword org danger zone as a full delete, drop revert-to-personal copy
- **platform:** Tidy console card layout when stacked on mobile
- **layout:** Stop header search box from overlapping the sidebar toggle on mobile

## [3.4.5](https://github.com/mahesivaya/wayve/releases/tag/v3.4.5) - 2026-06-23

### 🚀 Features

- **github:** Add read-only Pull Requests tab to Code Repo page

### 🧹 Maintenance

- Run smoke/e2e/security on PRs and version tags, not every push to main

## [3.4.4](https://github.com/mahesivaya/wayve/releases/tag/v3.4.4) - 2026-06-23

### 🚀 Features

- **home:** Expand hero mockup slides and add an integrations showcase

## [3.4.3](https://github.com/mahesivaya/wayve/releases/tag/v3.4.3) - 2026-06-23

### 🚀 Features

- **home:** Refresh hero copy (tagline, headline, CTAs, chips)

## [3.4.2](https://github.com/mahesivaya/wayve/releases/tag/v3.4.2) - 2026-06-23

### 🐛 Bug Fixes

- **home:** Render the brand logo in the footer instead of a faint glyph

## [3.4.0](https://github.com/mahesivaya/wayve/releases/tag/v3.4.0) - 2026-06-23

### 🚀 Features

- **user-logs:** Add per-user time-on-site table

## [3.3.5](https://github.com/mahesivaya/wayve/releases/tag/v3.3.5) - 2026-06-23

### 🚀 Features

- **chat:** Relocate search to the sidebar and refine sidebar headers/rows

## [3.3.4](https://github.com/mahesivaya/wayve/releases/tag/v3.3.4) - 2026-06-23

### 🚀 Features

- **chat:** Merge people into the channel list and relabel group visibility

### 🧹 Maintenance

- **theme:** Rename email-* surface tokens to neutral --color-canvas/--color-pane

## [3.3.3](https://github.com/mahesivaya/wayve/releases/tag/v3.3.3) - 2026-06-23

### 🐛 Bug Fixes

- **scheduler:** Theme the sidebar/canvas off email-bg so it follows the selected color
- **drive:** Show download prompt when the browser can't display PDFs inline
- **drive:** Preview PDFs inline instead of downloading

## [3.3.2](https://github.com/mahesivaya/wayve/releases/tag/v3.3.2) - 2026-06-22

### 🐛 Bug Fixes

- **slack:** Drop custom icon on bridged messages, use default avatar
- **chat:** Keep the open conversation across a refresh via the URL

## [3.3.1](https://github.com/mahesivaya/wayve/releases/tag/v3.3.1) - 2026-06-22

### 🚀 Features

- **slack:** Post outbound messages under the Wayve sender's name

### 🐛 Bug Fixes

- **tasks:** Theme Jira panel with app color tokens

## [3.3.0](https://github.com/mahesivaya/wayve/releases/tag/v3.3.0) - 2026-06-22

### 🚀 Features

- **chat:** Show sender name + avatar on channel messages
- **chat:** Render bridged Slack messages as received, with author
- **slack:** In-panel setup guide for Enterprise admins
- **slack:** Real-time Slack Events webhook (Enterprise)

### 🐛 Bug Fixes

- **chat:** Make header/sidebar titles readable in dark mode
- **slack:** Resolve <@U…> mentions to real names via users.info
- **slack:** Conversations.list falls back to public channels + surfaces error
- **upload:** Raise nginx body limit to 50m and clean up 413 errors
- **desktop:** Land on /login after logout
- **nginx:** Proxy /webhooks/ to the backend
- **jira:** Backfill Jira tables in startup migrations

### 🧹 Maintenance

- **slack:** Complete Enterprise Slack onboarding guide
- Add Jira and Slack integration setup guides
- **changelog:** Update for v3.2.1 [skip ci]

## [3.2.1](https://github.com/mahesivaya/wayve/releases/tag/v3.2.1) - 2026-06-21

### 🚀 Features

- **theme:** Paint the page background with the chosen theme colour
- **chat:** Surface recent conversations above the channels list
- **home:** Rework hero headline

### 🐛 Bug Fixes

- **theme:** Persist grid and slider edits so they survive closing the panel

### 🧹 Maintenance

- **changelog:** Update for v3.2.0 [skip ci]

## [3.2.0](https://github.com/mahesivaya/wayve/releases/tag/v3.2.0) - 2026-06-21

### 🚀 Features

- **github:** Render commit diffs side-by-side with darker colors

### 🧹 Maintenance

- **changelog:** Update for v3.1.1 [skip ci]

## [3.1.1](https://github.com/mahesivaya/wayve/releases/tag/v3.1.1) - 2026-06-21

### 🚀 Features

- **integrations:** GitLab issue badge on Tasks + import wiremock test

### 🧹 Maintenance

- **changelog:** Update for v3.1.0 [skip ci]

## [3.1.0](https://github.com/mahesivaya/wayve/releases/tag/v3.1.0) - 2026-06-21

### 🚀 Features

- **integrations:** Add per-user GitLab connection and issue import
- **integrations:** Hide Slack tile from personal and business accounts

### 🧹 Maintenance

- **changelog:** Update for v3.0.0 [skip ci]

## [3.0.0](https://github.com/mahesivaya/wayve/releases/tag/v3.0.0) - 2026-06-21

### 🚀 Features

- **enterprise:** Tier separation, standard encryption, and Slack integration
- **org:** Drop self-serve payment-gated organization signup

### 🧹 Maintenance

- **changelog:** Update for v2.5.2 [skip ci]

## [2.5.2](https://github.com/mahesivaya/wayve/releases/tag/v2.5.2) - 2026-06-19

### 🚀 Features

- **platform-billing:** Gate Billing console on the platform feature-access matrix
- **tasks:** Drop the Assigned by picker; attribute new tasks to their creator
- **settings:** Hide Transaction history for platform users

### 🐛 Bug Fixes

- **github:** Label the commit-diff reload action "Refresh"

### 🧹 Maintenance

- **changelog:** Update for v2.5.1 [skip ci]

## [2.5.1](https://github.com/mahesivaya/wayve/releases/tag/v2.5.1) - 2026-06-19

### 🚀 Features

- **chat:** Limit personal-account sidebar to 5 recent channels and latest users
- **sidebar:** Rename Emails to Inbox and Chat to Messages
- **feature-access:** Extend feature access to the platform scope
- **feature-access:** Add Billing to the access matrix

### 🐛 Bug Fixes

- **github:** Surface failed or empty commit-diff loads instead of a blank row

### 🧹 Maintenance

- **changelog:** Update for v2.5.0 [skip ci]

### Other Changes

- **theme:** Tidy theme imports and marketing/email CSS

## [2.5.0](https://github.com/mahesivaya/wayve/releases/tag/v2.5.0) - 2026-06-18

### 🚀 Features

- **feature-access:** Owner-managed per-org feature access (Code Repo)
- **projects:** Let org owners link a public repo, visible to org members

### 🐛 Bug Fixes

- **github:** Let org owners import a repo with no existing project
- **github:** Give organization accounts a project-based repo viewer

### 🧹 Maintenance

- **projects:** Cover org-owner repo linking + proxy allowlist
- **changelog:** Update for v2.4.1 [skip ci]

## [2.4.1](https://github.com/mahesivaya/wayve/releases/tag/v2.4.1) - 2026-06-18

### 🐛 Bug Fixes

- **sidebar:** Keep full labels when expanded at tablet widths

### 🧹 Maintenance

- **changelog:** Update for v2.4.0 [skip ci]

## [2.4.0](https://github.com/mahesivaya/wayve/releases/tag/v2.4.0) - 2026-06-18

### 🚀 Features

- **home:** Remove the Frequently Asked Questions section
- **billing:** Advertise 500 GB storage on the Most Advance plan

### 🐛 Bug Fixes

- **frontend:** Clear unused-var and floating-promise lint errors

### 🧹 Maintenance

- **changelog:** Update for v2.3.0 [skip ci]
- **gitignore:** Ignore the decentralization/ docs folder

### Other Changes

- **theme:** Reformat ThemeCustomizer (import order + indentation)

## [2.3.0](https://github.com/mahesivaya/wayve/releases/tag/v2.3.0) - 2026-06-18

### 🐛 Bug Fixes

- **home:** Readable FAQ + capability chips on the light marketing surface
- **home:** Align 'Who it's for' tiers with account scopes
- **ui:** Clean up landing-page footer
- **ui:** Theme-visible search text; profile-menu and search tweaks
- **ui:** Inset admin dashboard grid; fix oversized Audit Logs heading

### 🧹 Maintenance

- **changelog:** Update for v2.2.4 [skip ci]
- **email:** Remove the Yahoo Mail provider

## [2.2.4](https://github.com/mahesivaya/wayve/releases/tag/v2.2.4) - 2026-06-17

### 🚀 Features

- **theme:** Theme-aware chrome, buttons & empty states; new brand mark
- **sidebar:** Route placeholder add-to-sidebar apps to Coming Soon
- **errors:** Add 404 page + nginx 5xx maintenance page, log render crashes
- **domains:** Route Domains to a Coming Soon placeholder page
- **tasks:** Show task creation date and time on cards
- **organization:** Remove Settings tile from org owner home

### 🧹 Maintenance

- **changelog:** Update for v2.2.3 [skip ci]

## [2.2.3](https://github.com/mahesivaya/wayve/releases/tag/v2.2.3) - 2026-06-17

### 🚀 Features

- **platform:** Move Members & roles to the sidebar; drop Support/Developer/Security cards from owner home; wider sidebar + looser console grid

### 🐛 Bug Fixes

- **lint:** Clear production clippy (dead serve_file_row, complex type alias, collapsible if); clippy gate + pre-commit hook drop --all-targets
- **docker:** Bump frontend nginx base to 1.29-alpine to clear fixable Alpine HIGH/CRITICAL CVEs
- **deps:** Npm audit fix — clear high-severity frontend vulns (@babel/core, dompurify)

### 🧹 Maintenance

- **ci:** Git-cliff changelog automation (release job + justfile recipe + cliff.toml) and pre-commit hook
- **e2e:** Target brand button by class (logo also contributes to its accessible name)
- **e2e:** Brand wordmark assertion is Fluxze, not Wayve
- **e2e:** Login helper targets the 'Email or username' placeholder
- **auth:** Update Login test for the 'Email or username' placeholder
- **security:** Mark SARIF uploads non-fatal (private repo has no GHAS code scanning)

### Other Changes

- Cargo fmt + prettier --write to fix CI format gates

## [2.2.2](https://github.com/mahesivaya/wayve/releases/tag/v2.2.2) - 2026-06-17

### 🐛 Bug Fixes

- **theme:** Theme-aware chrome surfaces + single-view appearance editor; B&W clean white

## [2.2.1](https://github.com/mahesivaya/wayve/releases/tag/v2.2.1) - 2026-06-16

### 🚀 Features

- **teams:** Platform owners create platform-level teams via the sidebar +

## [2.2.0](https://github.com/mahesivaya/wayve/releases/tag/v2.2.0) - 2026-06-16

### 🐛 Bug Fixes

- **crypto:** Persist keystore so hard refresh doesn't re-prompt the mnemonic; wipe keys on logout

### Other Changes

- Surface storage limit in notification bell + banner, gated to personal users & org owners

## [2.1.2](https://github.com/mahesivaya/wayve/releases/tag/v2.1.2) - 2026-06-16

### Other Changes

- Contrast button toggles pure black & white (white/black)

## [2.1.1](https://github.com/mahesivaya/wayve/releases/tag/v2.1.1) - 2026-06-16

### Other Changes

- Scope-specific recovery key filenames (personal/org/platform)

## [2.1.0](https://github.com/mahesivaya/wayve/releases/tag/v2.1.0) - 2026-06-16

### Other Changes

- Attachments button opens the all-attachments Files view

## [2.0.4](https://github.com/mahesivaya/wayve/releases/tag/v2.0.4) - 2026-06-16

### 🐛 Bug Fixes

- **docs:** Readable Developers page text in dark theme
- **plan-admin:** Readable plan CODE pills on dark theme
- **scheduler:** Unify dark-theme background to one dark navy
- **chat:** Readable received-message bubbles on dark theme

### 🧹 Maintenance

- **docs:** Remove in-shell nav menu, render full-width content

## [2.0.3](https://github.com/mahesivaya/wayve/releases/tag/v2.0.3) - 2026-06-15

### Other Changes

- **user:** Simplify intro copy, smaller heading + intro font
- Sample Workspace repos + Teams as display fallback when empty

## [2.0.2](https://github.com/mahesivaya/wayve/releases/tag/v2.0.2) - 2026-06-15

### 🐛 Bug Fixes

- **audit:** Readable Submit button text on the dark panel

### 🧹 Maintenance

- **release:** Let GitHub pick Latest by semver (make_latest: legacy)
- **release:** Tag-triggered GitHub Release workflow + commit/versioning docs

## [2.0.1](https://github.com/mahesivaya/wayve/releases/tag/v2.0.1) - 2026-06-15

### Other Changes

- Readable conversation names/emails on the dark sidebar

## [2.0.0](https://github.com/mahesivaya/wayve/releases/tag/v2.0.0) - 2026-06-15

### 🐛 Bug Fixes

- **rbac:** Owner-delete returned 500; block with clear 403
- Generic IMAP/SMTP connector for custom-domain mailboxes
- Consolidate all log/audit pages under one /logs/* namespace
- **ui:** Stop page flicker — soft 401 redirect + per-content Suspense
- Restrict audit views to owners only
- Cache RBAC role context in Redis (45s TTL)
- Collapse role->permission matrix into one declarative table
- Extract setup-docker-stack composite action, name DAST/smoke phases
- Signaling has no authorization

### 🧹 Maintenance

- Add 1:1 WebRTC calling architecture doc
- Enforce cargo fmt --check in backend job; format backend
- **frontend:** Repo-wide Prettier/ESLint/Stylelint formatting pass + config
- Remove 'Docs › <page>' breadcrumb block from docs shell
- Single frontend route/sidebar registry + feature recipe
- Redis pub/sub performance + chat logging coverage
- Extract shared useResizableWidth hook + ResizeHandle
- Collapsible nav dropdowns + fix scroll in the app shell
- Test scripts for some functions
- Signup through gmail directly bug
- Signup through gmail directly
- Auth encrypt bug
- Cargo fmt error
- Show panics
- Cargo fmt errors
- Made hard coded paths with global for easy prod deployment
- Replaced custom macro with simple tracing
- Dev logs
- Commented tracing as it is not in production
- Tracing to log more more data for production, here using it for basic knowledge
- Import order fixed
- Fixed duplicate import
- Fixed duplicate logging dir
- Changed dir name
- Bug fix
- Added profile/accounts update feature and also AI chat
- CSS background color changes fix
- Not found fix
- New notes app.
- Allow left pane also to change
- Split the UI
- Basic pipeline setup test
- Basic pipeline setup
- Basic pipeline setup

### Other Changes

- Dark Fluxze wordmark + updated public header/logo
- Drop Page column, mute only empty cells, brighten summary row
- Section icons + keep collapsed-rail sections collapsed
- Settings button pinned to the bottom of the left nav
- User Audit page + non-consequential activity stream
- Notification dropdown scrolls to show all unread items
- Notification bell with combined unread email + chat count
- Access/email/chat/calendar/drive/notes/tasks activity tables on /logs/audit
- Assignee/assigned-by user autocomplete with avatars
- File attachments in DMs with per-user encrypt-files toggle (E2E or server-encrypted); Settings toggle switch
- Preserve401 on repo/language calls so a GitHub-side 401 doesn't log the user out
- Repos-as-blocks page (top-3 languages) opening into Code Repo; repo switcher above branch; home Projects cards; graceful 404
- Jira board view toggle (List/Grid/Columns) with drag-and-drop
- Live unread-count badge on Chat row (mirrors Emails badge)
- Revert body-snippet preview (E2E bodies can't be server-decrypted); keep Inbox/Sent tabs + toolbar fixes
- Body snippet in list rows (server-decrypted preview); Inbox/Sent tabs; toolbar border fixes; single-pane no highlight box
- Compose in toolbar (centered, wider), view toggles before right-aligned search, transparent search row; tasks single-page; notes header removed
- Remove non-functional filter blocks from sidebar
- Grid view tiles cards into responsive columns (was single-column)
- Hide Teams for personal accounts; highlight "+ Add" as a button
- Personal accounts add their own public repos per project
- Personal-account app picker (+ Add) with checkbox grid; open Code Repo to all authed users
- Add missing /api prefix to shared-inbox and SSO client paths
- Logout no longer flashes /login; icons refactored to lucide-react
- Code Repo nav item + Git logo; project rename/delete menu
- Login by email-or-username; self-service password change re-wraps key; route error boundary; org settings in /settings
- Live stats on platform + business owner home cards; honest org billing
- Business page as table + detail drawer (list/block toggle)
- Tickets only on Support page; show closed tickets by default
- Clickable ticket rows open a detail modal
- Home support-tickets panel shows all tickets with status
- New-issues inbox on owner home; direct business signup; per-org domain toggle; recover-member chat fix
- Harden 1:1 WebRTC — buffer ICE, drop-detect, camera toggle, duration
- Use fluxze.png logo (header/footer + favicon), larger sizes
- Logo before wordmark on public Home nav; fit Developers dropdowns on mobile
- Add Fluxze hexagon logo mark (header, marketing nav/footer, favicon)
- Upload / change / remove profile image via shared Avatar
- Hide assignment fields (Assigned by / Assignee / Assign to me) for personal accounts
- Revert-to-personal grants Most Advance; /pricing org CTAs
- Org accounts resolve current plan from the org sub, not a stale personal one
- Revert-to-personal in Org Settings + Startups->Business upgrade
- Storage limit tracks the active plan, not the webhook snapshot
- Self-serve Startups upgrade for personal users
- 3 personal + 3 business plan tiers
- Disable self-serve personal→business account upgrade
- **deps:** Patch react-router DoS + maxminddb unsoundness
- Remove Pricing section + 'support' FAQ item from landing page
- Remove 'Stop paying for five tools' CTA band from landing page
- Prettier-format frontend
- Show Location (city/region/country) like User Logs
- Click a file/image to open an inline preview (images + PDFs)
- Hide file type under the name (size only); bolder ⋯ trigger
- Folders get the same ⋯ menu (Open/Rename/Info/Delete); drop name header from menus
- Replace per-file Download button with a ⋯ actions menu (Download/Rename/File info/Delete)
- Real image thumbnails for image files (lazy, client-side decrypt)
- Compact single-line toolbar + 3-option Layout (List/Grid/Large grid)
- Remove sharing (private only); Documents becomes the org/platform shared store
- Fix uploads landing in root instead of the target folder
- Unread counts + Unread/Recent sections in the people list
- Live delivery/read ticks without reload (DMs)
- Show full email in People list (no duplicate names)
- Data-driven section registry (de-dup the collapsible groups)
- Left-align standalone section labels (e.g. Organization)
- Pre-create app-owned /app/uploads + /app/logs in image
- Set browser tab title to Fluxze (was 'frontend')
- WhatsApp-style delivery ticks (✓ / ✓✓ / blue ✓✓), with working status transitions
- Keep collapsible sections (Developers etc.) open across navigation
- Org Settings rename + cancel→delete flow; routes module refactor
- Payment-gated organization creation
- Order new tasks to the bottom of their priority group (created_at ASC)
- Fix create 500 (stale status constraint in startup bootstrap) + attachment File-create error on virtiofs
- Fix Assign-to-me checkbox stretched full-width by generic input rule
- Month '+N more' cap + flush views; dev nginx per-request backend resolve
- Org Documents drive + Projects/Teams; scheduler CSS fixes
- Manager-only Add-member button on team pages
- Enterprise realtime reliability (reconnect/heartbeat, since_id resync, Redis pub/sub fan-out) + misc session changes
- Add Teams sidebar group + team detail page
- Project links open GitHub page + inline-editable, persisted names
- Custom downward branch dropdown (replace native select)
- Fit view to pane height, tight padding + stark square block edges
- List project names only (remove Code sub-blocks), fix label styling
- Macro-parity customizer — library, randomize, import/export, UI tab
- Move sidebar show/hide toggle above Home
- Move API Keys into the Developers sidebar dropdown
- Sidebar groups always start collapsed on load
- Resizable nav sidebar + Workspace→Projects→Code nesting, grabbable dividers
- Org-chart tree view, consolidated create form, nav + misc UI
- Drop ActivityDashboard from admin home + flush console tiles (no panel box)
- Remove the 'Organization consoles' header block from the admin home
- Drop the bordered panel box on the admin home so console cards sit flush
- Remove the 'Platform consoles' header block from the admin home
- Wire up macOS Developer ID signing + notarization (env-gated)
- Point macOS installers at new S3 keys
- Open the shell directly at /login (skip marketing home)
- Hide login marketing header in the desktop (Electron) app only
- Add spacing below the Add Channel button
- Drag-resizable sidebar, restyle channels header
- Compact header search + tighter page padding
- Collapsible groups, reorder, smaller header
- Serve desktop installers from S3
- Cross-platform Download App picker + win/linux builds
- Show public header (no auth buttons) on login & register
- Mobile header hamburger menu + compact footer
- Add Electron macOS wrapper app for fluxze.com
- Fix landing-page horizontal overflow on mobile
- Remove welcome greetings + move Create secrets to sidebar
- Interactive hero mock with Gmail-style left-aligned lists
- Fix participant input overlapping the Add button
- Simpler channel creation + websocket reconnect fix
- Upsert subscription on inline webhook + proxy /billing/webhook in prod nginx
- Wayve -> Fluxze across user-facing copy
- Navy email-body background + compose encryption-mode radios
- Fix 404 loading Fluxze-native (account-less) message bodies
- Logout to home, match home bg to app surface, brighten dark sidebar labels
- Icon-rail middle breakpoint + dynamic toggle arrow
- Theme customizer + landing/pricing + billing audit work
- Circuit-board background for Login + Register
- Render HTML body + show remote images
- Show the /pricing view on the landing page (shared component)
- Enlarge the Products dropdown to a comfortable size
- Remove /enterprise page + compact the landing UI
- Render HTML emails (with images) in a sandboxed iframe
- Restrict self-service account deletion to personal accounts
- Add Trash folder (TRASH label) to sidebar + list, exclude from inbox
- Light up Social/Updates/Important category folders
- Persist open email across refresh + show full received date/time
- **emails:** Cap email body width + size for readable plaintext rendering
- Record org/platform role changes in audit_logs + show on dashboard
- Record failed login attempts in audit_logs (breach signal)
- **split:** Collapse scheduler + make log tables responsive in split panes
- Track everyone who opens the site + platform Visitors page
- List view default + hide account UI for business/platform
- Record email_sent / email_received in the enterprise log
- Allow platform owners to connect a mailbox
- Serve stored body when live Gmail refetch fails (fix 502)
- Centralize product name in config/brand.ts (Wayve -> Fluxze)
- Self-service account deletion
- Drop 'Wayve' prefix from product names
- Restrict sidebar link + route to org/platform owners
- Record login on all app-login paths, not just password login
- Make the connect-conflict banner actionable
- Ignore all client_secret*.json, not just client_secret.json
- Empty-state CTA to connect a mailbox when no accounts
- Fix seed_users recovery_mode 'basic' -> 'full'
- Add apply-schema-prod.sh — shadow-DB diff that reconciles prod schema with init.sql (additive-only, dry-run by default)
- Make assigned_by/assignee optional in SaveTaskPayload (personal scope omits them); unblocks prod tsc build
- Rwayve.maheshg.me → fluxze.com (nginx www redirect, OAuth/SCIM/API URLs, deploy host)
- Dedicated sidebar section, User/Audit Logs split, org-scoped App+Audit logs
- Platform-owner backfill to provision missing E2E keypairs
- Record security-relevant user actions to DB + logs/user_actions.log
- Allow PATCH requests
- Rename GitHub nav label to Code
- Org/platform-scoped participant typeahead with match-as-you-type select
- Show Domains link to organization owners (nav only)
- Group public tiers into Personal + Business & Enterprise sections; fix marketing footer column alignment
- Center section headers; Business button reads 'Upgrade or Create account'
- Split plans into Plans (personal) and a separate Business & Enterprise section
- Redirect apex maheshg.me -> rwayve.maheshg.me; SES FROM uses apex
- Unselectable numbers + Download .txt
- Confirm-password field on create form
- Skip POST when org master key already exists
- 20s wait for personal pubkey, clearer loading + Retry button
- Click on emails icon is not showing good UX
- Create-task popup modal with full status workflow
- Introduce repo layer + encrypt subject at rest
- Auto-link paid plans to Stripe test prices on startup
- Backfill DRAFT/SPAM/TRASH + all Gmail categories; include tasks in storage
- Background worker now backfills older mail each tick
- Backend sync via /api/me/theme so themes follow users across devices
- Customizer with curated presets + macro-style OKLCH palette generator
- Tokenize all color literals so a runtime theme customizer is feasible
- Extract bootToken + defaultAccess helpers from AuthContext
- Enforce logger usage + catch floating promises via ESLint
- Align @types/react with React 18 runtime
- Scope nav + routes to personal account boundary
- Extract pure validation from create_meeting handler
- Split MailProviderClient into 4 narrow traits
- Extract ZoomClient trait + pure meeting-body builder
- Extract RawMailSender trait + pure meeting-message builder
- Parallelize stages 1-8 + dast (Layout A)
- Continue-on-error around ZAP, the failure is the upload step not the scan
- Skip ZAP action's broken artifact upload
- Also write infra/.env.development for the nginx service
- Today is not showing day's page
- Always force-recreate nginx so template changes apply
- Allow schedular without any plarticipant also
- Check secret files from root directory
- Instead of writing seperate code of multle service providers
- Resolve both-added conflict in api/client.ts
- Ignore unwanted warnings of 'not used'
- Apply rustfmt formatting
- Apply rustfmt formatting
- Apply rustfmt formatting
- Apply rustfmt formatting

## [1.0.0](https://github.com/mahesivaya/wayve/releases/tag/v1.0.0) - 2026-05-03

### Other Changes

- Show all emails body data

<!-- generated by git-cliff -->
