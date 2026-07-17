# Jujutsu (jj) — reference for this repo

[Jujutsu](https://jj-vcs.dev/) is a git-compatible VCS with a different working model: the working copy **is** a commit (`@`), there is no staging area, and every mutation is recorded in an operation log you can undo. In this repo it runs **colocated** with git (`.jj/` next to `.git/`), so `jj`, `git`, and `sl` (see [sapling.md](sapling.md)) all operate on the same commits and remote.

- Installed via Homebrew: `/opt/homebrew/bin/jj` (v0.43.0 at time of writing).
- Colocated setup was created with `jj git init --colocate` — jj auto-imports git refs at the start of every command and exports its changes back, so switching tools mid-flow is safe.
- Identity comes from `~/.config/jj/config.toml` (`jj config set --user user.name/user.email`).

## Core concepts (what's different)

- **`@` is the working copy, and it's a real commit.** Editing files silently amends `@` on the next jj command — there is no "uncommitted" state and no staging area.
- **Change IDs vs commit IDs.** Every change has a stable letter-ID (e.g. `yonvxszx`) that survives rewrites; the git SHA changes on every amend. Use change IDs in commands.
- **Descendants auto-rebase.** Amend a commit mid-stack and everything on top follows automatically — no `rebase --onto` chains.
- **Conflicts are first-class.** A rebase never stops halfway; conflicted commits are recorded as conflicted, and you resolve them whenever you like.
- **The operation log.** Every command (including working-copy snapshots) is an operation; `jj undo` reverts the last one, `jj op log` shows them all, `jj op restore` time-travels the whole repo.
- **Bookmarks ≈ git branches**, but nothing moves automatically: after new commits, point the bookmark with `jj bookmark move` before pushing.
- **Revsets.** `@` (working copy), `@-` (its parent), `main`, `trunk()`, `mine()`, `x::y` (range). See `jj help -k revsets`.

## git → jj translation

| git | jujutsu |
|---|---|
| `git status` | `jj st` |
| `git log --graph` | `jj log` |
| `git checkout <ref>` | `jj new <ref>` (start new work on top) or `jj edit <rev>` (modify in place) |
| `git checkout -b feat` | `jj bookmark create feat -r @` |
| `git add` + `git commit -m` | `jj commit -m "msg"` (describe `@`, start a fresh `@` on top) |
| `git commit --amend` | just edit files (auto-amends `@`), or `jj squash` to fold `@` into its parent |
| `git commit --amend` (msg only) | `jj describe -m "msg"` |
| `git rebase main` | `jj rebase -d main` |
| `git rebase -i` | `jj arrange` / per-commit `jj squash`, `jj split`, `jj rebase` |
| `git cherry-pick <sha>` | `jj duplicate <rev> -d @` (or `jj rebase -r <rev> -d @` to move) |
| `git revert <sha>` | `jj revert -r <rev>` |
| `git stash` | not needed — `jj new` leaves the WIP commit behind; come back with `jj edit` |
| `git pull` | `jj git fetch` (+ `jj rebase -d main` if needed) |
| `git push` | `jj bookmark move main -r <rev>` then `jj git push -b main` |
| `git blame <file>` | `jj file annotate <file>` |
| `git reset --soft HEAD^` | `jj squash --from @- --into @` (or `jj abandon @-` variants) |
| `git reflog` | `jj op log` (repo-wide) / `jj evolog` (one change's history) |
| `git branch -D` | `jj abandon <rev>` |

## Full command catalog (v0.43.0)

### History & inspection

| Command | What it does |
|---|---|
| `jj log` | Graph of revisions (`-r <revset>` to filter) |
| `jj show <rev>` | Metadata + diff of one revision |
| `jj diff` | Compare file contents between revisions (`--from`/`--to`) |
| `jj interdiff` | Diff between the *diffs* of two revisions |
| `jj status` / `jj st` | High-level repo status |
| `jj evolog` | How one change evolved over time (every amend) |
| `jj file annotate` | Per-line origin (blame); `jj file list/show/track/untrack` for file ops |
| `jj bisect` | Find a bad revision by bisection |
| `jj root` | Workspace root directory |

### Creating & editing changes

| Command | What it does |
|---|---|
| `jj new [rev]` | Start a new empty change on top (the default way to "check out") |
| `jj commit -m` | Describe `@` and open a fresh change on top |
| `jj describe -m` | Set/update a change's description |
| `jj metaedit` | Edit metadata (author, date) without touching content |
| `jj edit <rev>` | Make an existing revision the working copy (direct in-place editing) |
| `jj squash` | Move changes from one revision into another (default: `@` → parent) |
| `jj split` | Split a revision in two (interactive) |
| `jj absorb` | Auto-distribute `@`'s changes into the right commits of the stack |
| `jj diffedit` | Touch up a revision's content in a diff editor |
| `jj restore` | Restore paths from another revision |
| `jj revert -r <rev>` | Create the inverse of a revision |
| `jj duplicate` | Copy revisions (cherry-pick without moving) |
| `jj abandon <rev>` | Drop a revision (descendants rebase onto its parent) |
| `jj fix` | Run formatters across revisions and rewrite them |
| `jj sign` / `jj unsign` | Add / drop cryptographic signatures |

### Rearranging the graph

| Command | What it does |
|---|---|
| `jj rebase -r/-s/-b <rev> -d <dest>` | Move a revision / its subtree / whole branch |
| `jj arrange` | Interactively arrange the commit graph |
| `jj parallelize` | Turn a stack into siblings |
| `jj simplify-parents` | Remove redundant parent edges |
| `jj next` / `jj prev` | Move `@` down/up the stack (`--edit` to edit in place) |
| `jj resolve` | Resolve conflicted files with a merge tool |

### Undo & the operation log

| Command | What it does |
|---|---|
| `jj undo` | Undo the most recent operation |
| `jj redo` | Redo the most recently undone operation |
| `jj op log` | List all operations (every command, every snapshot) |
| `jj op restore <id>` | Restore the entire repo to a previous operation |
| `jj op diff` | What an operation changed |

### Bookmarks, tags, remotes

| Command | What it does |
|---|---|
| `jj bookmark list/create/move/delete` | Manage bookmarks (≈ branches); `jj b` alias |
| `jj tag` | Manage tags (this repo's release tags stay on **git**: annotated `v*`) |
| `jj git fetch` | Fetch from the git remote |
| `jj git push -b <bookmark>` | Push a bookmark (`--change <rev>` auto-creates one) |
| `jj git import/export` | Manually sync git refs (automatic in colocated repos) |
| `jj git remote` | Manage remotes |
| `jj gerrit` | Gerrit code review integration |

### Workspace & misc

| Command | What it does |
|---|---|
| `jj workspace` | Multiple working copies of one repo (≈ git worktree) |
| `jj sparse` | Sparse checkouts |
| `jj run` | Run a command across a set of revisions |
| `jj config` | Get/set config (`--user` / `--repo`) |
| `jj util` | Shell completions and other utilities |
| `jj help -k <topic>` | Keyword help: `tutorial`, `revsets`, `filesets`, `templates`, `config`, `glossary` |

## Common workflows

### Daily loop

```bash
jj git fetch                      # get remote commits
jj log                            # orient
jj new main                       # start a change on top of main
# ...edit files (auto-snapshotted into @)...
jj commit -m "feat(x): ..."       # finalize, opens fresh @ on top
jj bookmark move main -r @-       # point main at the finished commit
jj git push -b main               # publish
```

### Fixing something mid-stack

```bash
jj edit <change-id>     # jump into the commit that needs the fix
# ...edit files — descendants rebase automatically...
jj new top()            # jump back on top when done
# or without leaving the top:
jj absorb               # hunks in @ auto-squash into the commits that own those lines
```

### Undo anything

```bash
jj op log               # see the operation history
jj undo                 # revert the last operation
jj op restore <op-id>   # nuclear option: whole-repo time travel
jj evolog -r <change>   # see every version a change went through
```

## Three tools, one repo (git + sl + jj)

All three see the same commits; state that is *not* shared is per-tool:

- **git**: branches are the source of truth; hooks/CI/releases (`v*` tags) live here.
- **sl (dotgit)**: state in `.git/sl`; reads git refs directly.
- **jj (colocated)**: state in `.jj/`; auto-imports/exports git refs on every command.

Ground rules to avoid confusion:

- Pick **one tool per unit of work** (a stack/PR); don't interleave rewrites of the same commits from two tools.
- Uncommitted edits are visible to all tools, but remember jj **snapshots them into `@`** the moment any jj command runs.
- `jj undo` / `sl undo` only know about operations made by their own tool.
- Conventional Commits apply regardless of the tool.
- Anything already pushed (`origin/main`) is immutable to jj by default (`immutable_heads()`), which is the behavior you want.
