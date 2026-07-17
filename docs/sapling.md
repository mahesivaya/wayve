# Sapling SCM — reference for this repo

[Sapling](https://sapling-scm.com/) is Meta's source-control system. It is git-compatible: in this repo it runs in **dotgit mode**, working directly against the existing `.git` directory (its state lives in `.git/sl`). `git` and `sl` commands can be freely mixed — same commits, same branches, same remote.

- Installed via Homebrew: `brew install sapling` → `/opt/homebrew/bin/sl` (v0.2.20260522 at time of writing).
- **Do not run `sl init --git .` here.** On this build it creates a stray `.sl/` directory with a fresh embedded git store that shadows dotgit mode (symptom: `sl status` shows every file as `?`). If that ever happens, delete `.sl/` — sapling auto-initializes `.git/sl` the first time any `sl` command runs inside a git repo.
- Identity comes from the user config (`~/Library/Preferences/sapling/sapling.conf`), set to match `git config user.name/email`.

## Why bother when git works?

- **First-class stacked commits** — `next`/`previous`/`absorb`/`split`/`fold` make a stack of small commits cheap to maintain (no interactive rebase gymnastics).
- **`sl undo`** — undoes the last *operation* (rebase, amend, pull…), not just commits.
- **Smartlog** — `sl ssl` shows only *your* relevant commits as a graph, not the whole history.
- **No staging area** — `commit`/`amend` operate on the working copy directly; use `-i` for interactive hunk selection when you want partial commits.
- **ISL GUI** — `sl web` and the VS Code/Cursor extension give a drag-to-rebase visual smartlog.

## git → sl translation

`sl githelp -- <git command>` translates any git invocation. Quick map:

| git | sapling |
|---|---|
| `git status` | `sl status` |
| `git log --graph --oneline` | `sl smartlog` (alias `sl ssl`) |
| `git log` | `sl log` |
| `git checkout <ref>` | `sl goto <ref>` |
| `git checkout -b feat` | `sl bookmark feat` (or just commit — anonymous heads are fine) |
| `git add <new-file>` | `sl add <file>` |
| `git add -p` + `git commit` | `sl commit -i` |
| `git commit -am "msg"` | `sl commit -m "msg"` |
| `git commit --amend` | `sl amend` |
| `git commit --amend` (msg only) | `sl metaedit` |
| `git rebase main` | `sl rebase -d main` |
| `git rebase -i` | `sl histedit` (or `sl chistedit` for the TUI) |
| `git cherry-pick <sha>` | `sl graft <sha>` |
| `git revert <sha>` | `sl backout <sha>` |
| `git stash` / `git stash pop` | `sl shelve` / `sl unshelve` |
| `git pull` | `sl pull` |
| `git push origin main` | `sl push --to main` |
| `git blame <file>` | `sl annotate <file>` (alias `sl blame`) |
| `git bisect` | `sl bisect` |
| `git clean -fd` | `sl clean` (a.k.a. `sl purge`) |
| `git diff` / `git diff HEAD~1` | `sl diff` / `sl diff -r .^` |
| `git show <sha>` | `sl show <sha>` |
| `git reset --soft HEAD^` | `sl uncommit` |
| `git reflog` + `git reset` | `sl undo` / `sl redo` / `sl journal` |
| `git branch -D` (drop work) | `sl hide <commit>` (recoverable via `sl unhide`) |

### Revsets (how you name commits)

- `.` = current commit, `.^` = its parent, `.^^` or `.~2` = grandparent
- `main`, `remote/main` = bookmark / remote bookmark
- `abc123` = hash prefix; `top` / `bottom` = ends of the current stack
- Expressions: `sl log -r "draft()"` (your unpublished commits), `ancestors(.)`, `descendants(x)`, `x::y` (range). See `sl help revisions`.

## Full command catalog (v0.2.20260522)

### Getting commits and viewing history

| Command | What it does |
|---|---|
| `sl clone <url>` | Copy an existing repository (git URLs supported) |
| `sl pull` | Pull commits from the remote |
| `sl push --to <bookmark>` | Push commits to the destination bookmark |
| `sl log` | Show commit history (`-r` revset, `-l` limit, `-p` patches) |
| `sl smartlog` / `sl ssl` | Graph of the commits relevant to *you* |
| `sl show <rev>` | Show one commit in detail |
| `sl diff` | Diff between commits / working copy |
| `sl annotate <file>` | Per-line commit info (blame) |
| `sl grep <pattern>` | Search tracked files |
| `sl histgrep` | Search a pattern backwards through history |
| `sl cat -r <rev> <file>` | File content at a revision |
| `sl files` | List tracked files |
| `sl heads` | Show head commits |
| `sl identify` / `sl whereami` | Identify the working-copy commit |
| `sl root` | Print repo root |
| `sl summary` | Summarize working-directory state |
| `sl journal` | History of where `.` (or a bookmark) has pointed |
| `sl blackbox` | View recent repository events (debug log) |

### Working copy

| Command | What it does |
|---|---|
| `sl status` | List files with pending changes |
| `sl add` / `sl remove` | Start / stop tracking + delete |
| `sl forget` | Stop tracking, keep the file on disk |
| `sl addremove` | Add all new files, forget all missing ones |
| `sl rename` / `sl copy` / `sl uncopy` | Record renames/copies for the next commit |
| `sl revert <file>` | Restore file(s) to match a commit (`-r`) |
| `sl clean` / `sl purge` | Delete untracked files |
| `sl shelve` / `sl unshelve` | Stash / unstash pending changes |
| `sl goto <rev>` | Check out a commit (`-C` to discard local changes) |

### Making and modifying commits

| Command | What it does |
|---|---|
| `sl commit -m "msg"` | Commit all pending changes (`-i` interactive hunk selection) |
| `sl record` | Interactively select changes to commit (like `git add -p`) |
| `sl amend` | Meld pending changes into the current commit (`--to` for mid-stack) |
| `sl metaedit` | Edit commit message/metadata without touching content |
| `sl absorb` | Auto-distribute pending edits into the right commits of your stack |
| `sl uncommit` | Move the current commit's changes back to pending |
| `sl unamend` | Undo the last amend |
| `sl split` | Split a commit into smaller ones |
| `sl fold --from <rev>` | Squash multiple commits into one |

### Rearranging commits

| Command | What it does |
|---|---|
| `sl rebase -s <src> -d <dest>` | Move commits (`-r` single, `-b` whole branch) |
| `sl histedit` / `sl chistedit` | Interactive reorder/combine/drop (editor / ncurses TUI) |
| `sl graft <rev>` | Cherry-pick a commit onto the working copy |
| `sl backout <rev>` | Commit the inverse of an earlier commit |
| `sl merge <rev>` | Merge a revision into the working directory |
| `sl resolve` | Re-run / mark conflict resolution (`--list`, `--mark`) |
| `sl continue` | Resume an interrupted rebase/histedit/graft after fixing conflicts |
| `sl hide <rev>` / `sl unhide` | Remove commits from view (recoverable, replaces branch deletion) |

### Navigating a stack

| Command | What it does |
|---|---|
| `sl previous` / `sl prev` | Check out the parent commit |
| `sl next` | Check out the child commit |
| `sl top` / `sl bottom` | (revsets) jump with `sl goto top` / `sl goto bottom` |

### Undo

| Command | What it does |
|---|---|
| `sl undo` | Undo the last local operation (`--preview` to see first) |
| `sl redo` | Undo the undo |
| `sl uncommit` / `sl unamend` / `sl unhide` / `sl unshelve` | Targeted inverses |
| `sl recover` | Roll back an interrupted transaction |

### Bookmarks, tags, phases

| Command | What it does |
|---|---|
| `sl bookmark <name>` | Create/list bookmarks (≈ git branches; `-d` delete) |
| `sl tag` / `sl tags` | Add / list tags (in dotgit mode prefer `git tag` — this repo's releases use annotated `v*` git tags) |
| `sl phase` | Show/set commit phase (public = pushed, draft = local) |

### GitHub integration

| Command | What it does |
|---|---|
| `sl pr submit` | Create/update GitHub PRs from your commits (`sl pr list`, `sl pr checkout <n>`, …) |
| `sl ghstack` | Submit a stack of commits as individual PRs (ghstack-style) |

Note: `sl pr` manages PR branches itself; on this repo the existing flow (git push + `gh pr create`) also keeps working — pick one per PR, don't mix.

### GUI

| Command | What it does |
|---|---|
| `sl web` | Launch ISL (Interactive Smartlog) in the browser; `--kill` stops the daemon, `--port <n>` fixes the port |
| VS Code / Cursor | Extension `meta.sapling-scm` (installed from VSIX; not on Open VSX). Settings in use: `sapling.isl.showInSidebar: true`, `sapling.commandPath: /opt/homebrew/bin/sl`. Open via the Sapling activity-bar icon or `Sapling SCM: Open Interactive Smartlog` |

### Maintenance & plumbing

| Command | What it does |
|---|---|
| `sl doctor` | Check and fix repo issues (first stop when something's weird) |
| `sl config` / `sl configfile` | Show settings / which file they come from (`sl config --user ui.username "Name <email>"` to set) |
| `sl gc` | Garbage-collect client caches |
| `sl verify` | Verify repository integrity |
| `sl archive` | Export an unversioned snapshot of a revision |
| `sl export` / `sl import` | Dump / apply patches |
| `sl bundle` / `sl unbundle` | Create / apply bundle files |
| `sl bisect` | Binary-search history for a regression |
| `sl paths` | Show remote aliases (here: `default = ssh://git@github.com/mahesivaya/wayve.git`) |
| `sl init` | Create a new repository (**avoid `--git .` in this repo — see top**) |
| `sl serve` | Stand-alone webserver (legacy; use `sl web`) |
| `sl subtree` | Directory/file branching in a monorepo |
| `sl prefetch` / `sl fs` | Remotefilelog / EdenFS plumbing (not used in dotgit mode) |
| `sl hint` | Acknowledge/silence hint messages |
| `sl version` | Version info |
| `sl help <topic>` | Help; topics: `filesets`, `glossary`, `patterns`, `revisions`, `templating` |

Deprecated: `sl branch` (use `sl bookmark`).

## Common workflows

### Daily loop

```bash
sl pull                     # fetch remote
sl ssl                      # where am I? what's new?
# ...edit files...
sl commit -m "feat(x): ..." # commit everything pending
sl push --to main           # publish
```

### Stacked development

```bash
sl goto main
# edit → sl commit -m "step 1"
# edit → sl commit -m "step 2"
# edit → sl commit -m "step 3"

sl prev                 # hop to step 2
# fix something...
sl amend                # fold the fix into step 2; descendants auto-restack
sl goto top             # back to step 3

# or skip the hopping entirely:
# edit files belonging to different commits of the stack, then
sl absorb               # each hunk lands in the commit that last touched it
```

### Fixing mistakes

```bash
sl undo --preview       # see what undo would do
sl undo                 # revert the last operation (rebase, amend, pull, ...)
sl redo                 # changed your mind
sl uncommit             # take the last commit back into pending changes
sl hide <rev>           # drop an abandoned line of work (unhide to recover)
sl journal              # where has `.` pointed recently?
```

### Conflicts

```bash
sl rebase -d main       # hits a conflict
sl resolve --list       # see conflicted files
# fix files, then:
sl resolve --mark <file>
sl continue             # resume the rebase
```

### Mixing with git (dotgit mode)

Everything is one repo — `git push` after `sl commit` works, `sl ssl` sees commits made with `git commit`. Conventions for this repo:

- Releases stay on **git**: annotated `v*` tags + `git push origin <tag>` (see CONTRIBUTING.md).
- Commit messages follow **Conventional Commits** regardless of which tool makes the commit.
- CI, hooks (`.githooks/pre-commit`), and GitHub Actions are untouched — they see normal git commits.

## Help topics

```bash
sl help commands        # everything above, live
sl help <command>       # detailed help (add --verbose for all flags)
sl help revisions       # revset language
sl help filesets        # file selection expressions
sl help patterns        # glob/regex file patterns
sl help templating      # custom log output
sl help glossary        # terminology
sl githelp -- <git cmd> # translate a git command to sl
```
