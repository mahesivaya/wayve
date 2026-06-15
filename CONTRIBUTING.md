# Contributing

## Commit messages — Conventional Commits

Write commit subjects as `type(scope): summary` (imperative, lower-case, no trailing period).

- **type** — one of: `fix`, `feat`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`.
- **scope** — the area touched, using the project's existing names: `chat`, `sidebar`, `emails`, `tasks`, `branding`, `auth`, `platform`, `audit`, `billing`, `api`, … (optional but encouraged).
- **breaking change** — append `!` after the type/scope **or** add a `BREAKING CHANGE:` footer.

Examples (real history):

```
fix(chat): readable conversation names on the dark sidebar
feat(sidebar): personal-account app picker
fix(audit): readable Submit button text on the dark panel
feat(api)!: drop legacy /v1 routes
```

Do **not** add a `Co-Authored-By: Claude` trailer to commits.

## Versioning — SemVer (`vMAJOR.MINOR.PATCH`)

The version lives in **annotated git tags** (the source of truth). The bump level is
determined by the commit types since the last tag:

| Change since last tag | Bump | Example |
| --- | --- | --- |
| any `!` / `BREAKING CHANGE:` | **major** | `v2.0.1 → v3.0.0` |
| any `feat` (no breaks) | **minor** | `v2.0.1 → v2.1.0` |
| only `fix` / `chore` / `docs` / … | **patch** | `v2.0.1 → v2.0.2` |

SemVer is about the **external contract** (HTTP API routes & payloads, DB schema columns
other code reads, required env vars, the auth/JWT/cookie contract, webhook shapes, API-key
scopes, user-facing behavior) — not the size of the diff. A large internal refactor with
identical behavior is a patch; a one-line API-field removal is major.

Baseline: `v2.0.0` at commit `1da69a9`.

## Cutting a release

1. Pick the bump level from the rule above and create an **annotated** tag on the commit to release:

   ```bash
   git bump patch            # or: git bump minor | git bump major   (alias below)
   # equivalently, without the alias:
   git tag -a v2.0.2 <commit> -m "v2.0.2 — short summary"
   ```

2. Push the tag (deliberate — `scripts/deploy.sh` and pushing to `main` never tag):

   ```bash
   git push origin v2.0.2
   ```

3. CI (`.github/workflows/release.yml`) fires on the `v*` tag and **publishes the GitHub
   Release automatically** with generated notes; the highest semver tag is marked *Latest*.
   No manual `gh release create` step needed.

### Optional: the `git bump` alias

A convenience alias that computes the next tag from the highest existing `v*` tag and creates
it (it does **not** push — you push deliberately). POSIX-safe, so it also works under `dash`/CI,
not just macOS bash:

```bash
git config --global alias.bump '!f() {
  type=${1:-patch};
  current=$(git tag -l "v[0-9]*" --sort=-v:refname | head -n1);
  current=${current:-v0.0.0}; current=${current#v};
  major=${current%%.*}; rest=${current#*.}; minor=${rest%%.*}; patch=${rest##*.};
  case "$type" in
    major) major=$((major+1)); minor=0; patch=0;;
    minor) minor=$((minor+1)); patch=0;;
    *)     patch=$((patch+1));;
  esac;
  next="v$major.$minor.$patch";
  echo "Bumping $current -> $next  (run: git push origin $next)";
  git tag -a "$next" -m "Release $next";
}; f'
```

Then: `git bump patch` / `git bump minor` / `git bump major` (default `patch`).
