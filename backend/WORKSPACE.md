# Backend Cargo Workspace

This document captures the process of converting the backend from a single
crate into a Cargo workspace, and extracting `wayve-security` as the first
sub-crate. It exists so the next extraction (`wayve-core` is the obvious
candidate) can follow the same well-trodden path without rediscovering the
traps.

The refactor was completed on **2026-05-25**, on a branch off `main`.

---

## Layout (current)

```
backend/
├── Cargo.toml                      ← workspace root (no [package])
├── Cargo.lock                      ← lockfile lives at workspace root
├── Dockerfile                      ← workspace-aware
├── clippy.toml
└── crates/
    ├── wayve-server/               ← the original "rwayve" crate, renamed
    │   ├── Cargo.toml
    │   └── src/
    │       ├── main.rs             ← binary entry point
    │       ├── ai/, billing/, chat/, drive/, ...   (feature modules)
    │       ├── routes/             (cross-cutting HTTP routes)
    │       ├── embed/              (embed-token middleware — re-exports
    │       │                        EmbedPrincipal from wayve-security)
    │       └── tests/              (integration tests; need a real DB)
    └── wayve-security/             ← extracted crate
        ├── Cargo.toml
        └── src/
            ├── lib.rs              ← declares the public module tree
            ├── config.rs           ← env-var helpers (jwt_secret, aes_key,
            │                        aes_hkdf_salt, auth_cookie_secure, siem)
            ├── api_key.rs          ← X-API-KEY validation, scope catalog
            ├── encryption.rs       ← AES-256-GCM + HKDF-SHA512
            ├── jwt.rs              ← HS256 + cookie/header extraction +
            │                        get_user_id_from_request chokepoint
            ├── oauth.rs            ← Google OAuth state store/consume
            ├── password.rs         ← bcrypt off the async runtime
            ├── rbac.rs             ← role matrix + permission catalog
            ├── sso.rs              ← OIDC/SSO client
            └── embed/
                ├── mod.rs
                └── middleware.rs   ← EmbedPrincipal struct (TypeId-shared
                                     with the wayve-server middleware)
```

The compiled binary still lands at `target/release/rwayve`. Operationally
nothing changed — this is purely a source-organization refactor.

---

## Why a workspace at all

The original backend was a single crate (~50 source files) named `rwayve`.
We considered a workspace once compile-time/boundary-enforcement value
started outweighing the migration cost. The four real-world triggers we
watched for:

| Trigger | Status when we did this |
|---|---|
| `cargo check` after a one-line edit > 10s | Approaching but not yet |
| A second binary that needs different deps | Not yet |
| Multiple devs stepping on shared files | Solo dev — no |
| A genuinely reusable piece of code | **Yes** — security primitives |

The last one carried it. `security/` was the highest-quality candidate for
extraction because:

1. **Clean DAG** — security is depended on by every feature module, but
   itself depends on almost nothing in those modules. Pulling it out is a
   one-way cut, not a graph untangling.
2. **Genuinely reusable** — RBAC + AES + HKDF + JWT + bcrypt is what every
   Rust web service needs. Could even be open-sourced.
3. **Tight scope** — 8 source files, well-defined surface area.
4. **Real testing surface** — pre-existing rbac/sso/api_key/encryption unit
   tests survive the move and prove the extraction worked.

`wayve-common` (a "shared utilities" crate) was considered first, as
tutorials commonly recommend. We rejected it: utility crates become junk
drawers, the surface area is too small to validate the workspace machinery
under realistic load, and the boundary it would create isn't load-bearing.

`wayve-database` was also considered. We rejected it for now too: the
backend doesn't use a repository pattern — queries are inline in handlers
via `sqlx::query`. A "database crate" would be 400 lines of pool setup
without enforcing the boundary it's supposed to provide.

---

## The four phases

Each phase was a checkpoint where work could be paused without leaving the
codebase in a broken state.

| Phase | What it does | Reversibility |
|---|---|---|
| 1. **Audit** | List deps in/out of security, no code changes | Read-only |
| 2. **Workspace shell** | Move src → crates/wayve-server, root becomes workspace, same binary still produced | One-commit revert |
| 3. **Extract** | Create wayve-security, move files, fix imports | High-touch but bounded |
| 4. **Validate** | cargo check / clippy / test / release build / docker | No code changes |

Total time: ~3.5 hours of focused work, including diagnosing one
significant Docker-cache failure.

---

## Phase 1 — Audit

The goal of Phase 1 is to know what you're moving BEFORE you move it.
Three things to inventory:

### Files in the extraction target

```bash
ls backend/src/security/
# api_key.rs encryption.rs jwt.rs mod.rs
# oauth.rs password.rs rbac.rs sso.rs
```

8 files. Mostly stable, well-tested.

### External imports from inside the target

```bash
grep -hE "^use crate::|^use super::" backend/src/security/*.rs \
  | grep -v "use crate::security" | sort -u
# use crate::config;
# use crate::error::AppError;
# use crate::prelude::*;
```

Three categories of cross-module dependency:
- `crate::config::X` — env-var helpers (jwt_secret, aes_key, auth_cookie_secure, ...)
- `crate::error::AppError` — the app's central error type, used by password.rs
- `crate::prelude::*` — re-exports of sqlx, actix, serde, etc.

Each gets a different handling strategy in Phase 3 (see the "Handling
cross-crate dependencies" section below).

### External callers of the target

```bash
grep -rln "crate::security" backend/src/ | grep -v "backend/src/security/" | wc -l
# 47
```

47 files in the rest of the backend reference security. These all need
their imports rewritten in Phase 3 — but it's a mechanical `sed`.

---

## Phase 2 — Workspace shell

Convert the root to a workspace, but don't create any new crates yet.
Result: identical binary, identical behavior, just laid out differently.

### Move the existing crate into `crates/wayve-server/`

```bash
cd backend
mkdir -p crates/wayve-server
git mv src crates/wayve-server/src
git mv Cargo.toml crates/wayve-server/Cargo.toml
mv Cargo.lock ../backend/Cargo.lock     # lock stays at workspace root
```

### New root `backend/Cargo.toml`

```toml
[workspace]
members = ["crates/wayve-server"]
resolver = "2"

[workspace.package]
edition = "2024"
version = "0.1.0"

[workspace.dependencies]
# All the deps from the old [dependencies], centralised here so sub-crates
# can say `actix-web.workspace = true` instead of duplicating versions.
actix-web = "4"
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "chrono", "json"] }
# ... (everything else)

[profile.release]
# Inherited by all members. Same settings as the pre-workspace crate —
# small binary on memory-constrained Docker builders.
opt-level = 1
codegen-units = 256
lto = false
incremental = false
```

### Update `crates/wayve-server/Cargo.toml`

```toml
[package]
name = "rwayve"             # KEEP the same binary name — Dockerfile + deploy expect this
version.workspace = true
edition.workspace = true

[[bin]]
name = "rwayve"
path = "src/main.rs"

[dependencies]
actix-web.workspace = true
sqlx.workspace = true
# ... every workspace dep this crate uses
```

### Verify

```bash
cd backend
cargo check --workspace      # should be clean
cargo build --release --workspace
ls target/release/rwayve     # binary still produced at same path
```

If the binary still builds and lives where the Dockerfile expects, Phase 2
is done. Safe checkpoint to commit if you want a smaller PR; we kept it
in-flight with Phase 3 because the audit was fresh.

---

## Phase 3 — Extract `wayve-security`

The actual extraction. Five sub-steps; the third one is where most of the
real engineering happens.

### 3.1 — Create the new crate

```bash
cd backend
mkdir -p crates/wayve-security/src
```

```toml
# crates/wayve-security/Cargo.toml
[package]
name = "wayve-security"
version.workspace = true
edition.workspace = true

[dependencies]
actix-web.workspace = true
sqlx.workspace = true
tokio.workspace = true        # password.rs uses spawn_blocking
thiserror.workspace = true    # for the local PasswordError enum
aes-gcm.workspace = true
bcrypt.workspace = true
hkdf.workspace = true
sha2.workspace = true
hmac.workspace = true
jsonwebtoken.workspace = true
base64.workspace = true
rand.workspace = true
moka.workspace = true
reqwest.workspace = true
anyhow.workspace = true
chrono.workspace = true
once_cell.workspace = true
serde.workspace = true
serde_json.workspace = true
tracing.workspace = true
```

Add it to the workspace `members`:

```toml
members = ["crates/wayve-server", "crates/wayve-security"]
```

### 3.2 — Move source files

```bash
git mv backend/crates/wayve-server/src/security/{api_key,encryption,jwt,oauth,password,rbac,sso}.rs \
       backend/crates/wayve-security/src/
git mv backend/crates/wayve-server/src/security/mod.rs \
       backend/crates/wayve-security/src/lib.rs
```

`lib.rs` then declares the module tree:

```rust
pub mod config;
pub mod api_key;
pub mod embed;
pub mod encryption;
pub mod jwt;
pub mod oauth;
pub mod password;
pub mod rbac;
pub mod sso;
```

### 3.3 — Handle cross-crate dependencies

This is the load-bearing step. Three categories from Phase 1, each with
its own strategy:

#### `crate::prelude::*` → explicit imports

The prelude re-exports actix-web types, sqlx, serde, etc. For a clean
extraction, replace blanket `use crate::prelude::*` in each moved file
with the specific things that file actually uses:

```rust
// before
use crate::prelude::*;

// after (in oauth.rs)
use anyhow::Result;
use sqlx::{PgPool, Row};
```

This makes the moved file's dependencies explicit and lets `cargo check`
catch leftover prelude expectations one by one.

#### `crate::config::X` → local config module in wayve-security

The security modules used 5 env-var helpers from `crate::config`:
`jwt_secret`, `aes_key`, `aes_hkdf_salt`, `auth_cookie_secure`, `siem`.

Strategy: duplicate them into a new `crates/wayve-security/src/config.rs`.
The duplication is intentional — small, stable surface area, no shared
abstractions worth building yet. The corresponding helpers were removed
from `crates/wayve-server/src/config.rs` since nothing else in wayve-server
called them. (`jwt_secret` and `aes_key` stayed in wayve-server because
embed/tokens.rs still uses them.)

If/when we extract `wayve-core` next, both `config.rs` files collapse into
one shared crate.

#### `crate::error::AppError` → local `PasswordError`

Only `password.rs` returned `Result<X, AppError>`. Defining a local
`PasswordError` (with `thiserror::Error`) and providing
`impl From<PasswordError> for AppError` in wayve-server's `error.rs`
keeps `?` working at all the call sites without making wayve-security
depend on the app's error taxonomy:

```rust
// in wayve-security/src/password.rs
#[derive(Debug, thiserror::Error)]
pub enum PasswordError {
    #[error("bcrypt failed: {0}")]
    Bcrypt(#[from] BcryptError),
    #[error("blocking task join failed: {0}")]
    Join(#[from] tokio::task::JoinError),
}

pub async fn hash_password(plaintext: &str) -> Result<String, PasswordError> { ... }

// in wayve-server/src/error.rs
impl From<wayve_security::password::PasswordError> for AppError {
    fn from(e: wayve_security::password::PasswordError) -> Self {
        AppError::Internal(format!("password operation failed: {e}"))
    }
}
```

The `?` operator picks up the `From` impl automatically — no caller
changes needed.

#### The `EmbedPrincipal` circular dep (the hardest one)

`security/jwt.rs::get_user_id_from_request` looks up two principal
types from `request.extensions()`:

```rust
req.extensions().get::<crate::api_key::ApiKeyPrincipal>()    // sibling — fine
req.extensions().get::<crate::embed::middleware::EmbedPrincipal>()  // CIRCULAR
```

`EmbedPrincipal` was originally defined in
`wayve-server/src/embed/middleware.rs`. If jwt.rs (now in wayve-security)
references it from there, security depends on the server crate — a cycle.

**The trap:** you can't just duplicate `EmbedPrincipal` in wayve-security
either. The lookup uses `TypeId`, which only matches when both sides
reference the *same type definition*. The middleware in wayve-server has
to insert exactly the type wayve-security looks up.

**The fix:** define `EmbedPrincipal` in wayve-security. The wayve-server
middleware re-exports it so its consumers' import paths don't change:

```rust
// crates/wayve-security/src/embed/middleware.rs
#[derive(Debug, Clone)]
pub struct EmbedPrincipal {
    pub user_id: i32,
    pub scopes: Vec<String>,
    pub jti: String,
}

// crates/wayve-server/src/embed/middleware.rs
pub use wayve_security::embed::middleware::EmbedPrincipal;
```

The path `crate::embed::middleware::EmbedPrincipal` resolves correctly
from inside wayve-security (it's a real module there) AND from inside
wayve-server (the re-export makes it look the same).

Similar circular-dep traps will show up for the next extraction — any
shared type that's looked up by `TypeId` has to live in the deeper crate.

### 3.4 — Update callers in wayve-server

Mechanical `sed` across 47 files:

```bash
find backend/crates/wayve-server/src -name "*.rs" -exec \
  sed -i '' 's|crate::security::|wayve_security::|g' {} \;
```

Then add `wayve-security = { path = "../wayve-security" }` to
`crates/wayve-server/Cargo.toml` and remove `pub mod security;` from
`main.rs`.

### 3.5 — Iterate until `cargo check --workspace` passes

The fix loop:

```bash
cargo check --workspace
# read first error
# fix
# repeat
```

For this extraction we hit ~5 categories of error:
- Module path: `crate::security::encryption::decrypt` → `crate::encryption::decrypt`
  (inside wayve-security, the security:: prefix is gone)
- `pub(crate)` visibility: items were `pub(crate)` and needed to be `pub`
  because consumers are now in a different crate
- Trait imports: `use sqlx::Row;` needed where it was previously pulled
  in by the prelude
- Missing `From<PasswordError> for AppError` impl (added in 3.3)
- The `EmbedPrincipal` circular dep (resolved in 3.3)

Each error is 30 seconds to fix individually.

---

## Phase 4 — Validate

Four checks. Anything red here means the extraction isn't done.

### `cargo check --workspace`

Should print `Finished dev profile`. The pre-existing `redis v0.25.4`
future-incompat warning is fine; it predates this refactor.

### `cargo clippy --workspace -- -D warnings`

Catches stray `dead_code` warnings (functions that were pub but are now
unused because the only callers were in security/). Either delete them
(if no other caller) or add `#[allow(dead_code)]` (if you have a real
reason to keep them around).

We deleted `aes_hkdf_salt()` and `auth_cookie_secure()` from
wayve-server's config.rs — they had no callers left.

### `cargo test --workspace --no-fail-fast -- --test-threads=1`

Expect:
- wayve-security: 18 tests pass (encryption, rbac, sso, api_key)
- wayve-server: 58 tests pass, 24 fail with "Set TEST_DATABASE_URL"
  (those need a real Postgres; same as pre-refactor)

DB-dependent failures are NOT a regression — they require a
`TEST_DATABASE_URL` env that wasn't set.

### `cargo build --release --workspace`

Produces `target/release/rwayve` (28 MB on arm64-darwin). Same name,
same path as before the refactor; the Dockerfile expects this.

### Local Docker build

This was the rough part. **Read this even if you're not extracting now —
the trap is real and Docker BuildKit doesn't warn you about it.**

The original Dockerfile had a clever cache-priming trick: copy
`Cargo.toml` + `Cargo.lock` first, build with a stub `src/main.rs`, then
copy real sources and rebuild. Heavy deps get cached on the first pass;
edits to source files only recompile the local crate.

When extended naively to a workspace, the stub trick **broke**:

1. First build (cache-priming pass): empty `crates/wayve-security/src/lib.rs`.
   Cargo built wayve-security as a crate with no exports. The compiled
   rmeta got pinned in BuildKit's cache mount for `/app/target`.
2. Second build (real sources): `lib.rs` now declares `pub mod jwt;` etc.,
   but cargo saw cached rmeta for an empty crate and skipped recompilation.
3. wayve-server then tried to import `wayve_security::jwt` and got
   84 "unresolved import" errors.

The fix had two parts:

**Simplify the Dockerfile** to skip the stub-then-real-source pattern.
Build the workspace in one pass with the real sources. The
`cargo-registry` / `cargo-git` cache mounts still preserve heavy
download time on subsequent builds — that's where the real win is.

**Version the cache-mount id** so future workspace-layout changes can
invalidate the entire cached `target/` in one bump:

```dockerfile
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=rwayve-workspace-target-v1,target=/app/target \
    cargo build --release --workspace \
    && cp /app/target/release/rwayve /app/rwayve.bin
```

When the workspace's crate set changes in a way that invalidates rmeta
(e.g., extracting `wayve-core` next), bump the `id` suffix from `v1` to
`v2`. The old cache will be ignored and the new build won't be served
stale entries.

**To force a clean rebuild manually:** `docker compose build --no-cache backend`.

After both fixes, the Docker build finishes in ~1m 16s and the
container is healthy in 6s.

---

## Lessons learned

| Lesson | What to do |
|---|---|
| BuildKit cache mounts can serve stale rmeta when a crate's contents change shape | Use a versioned `id=` on the `/app/target` cache mount. Bump on workspace layout changes. |
| The cache-priming stub trick is fragile for workspaces | Skip it. The registry/git mounts give you most of the savings. |
| `TypeId`-shared types must live in the lower crate | `EmbedPrincipal`, future `RequestPrincipal`-style types, anything looked up via `extensions().get::<T>()` |
| `use crate::prelude::*` defeats explicit dependency tracking | Replace with specific imports before extracting. Saves the iteration loop later. |
| Local `cargo check` passing doesn't guarantee Docker build passes | Always run a clean Docker build before pushing — caching can hide real issues. |
| `pub(crate)` becomes a leak on extraction | Audit visibility when moving — items needed by callers in a different crate must be `pub`. |
| The error-type extraction (PasswordError) is worth doing properly | Keeping AppError out of the extracted crate forces the consumer to add `impl From` — minimal pain, big payoff in independence. |

---

## How to do the next extraction (`wayve-core`)

The natural next crate is `wayve-core` — `prelude.rs`, `models/`,
`config.rs`, `external.rs`, `observability/devlog.rs`. It's bigger than
wayve-security but follows the same four-phase pattern.

1. **Audit**: list what's in `models/`, `prelude.rs`, `config.rs`,
   `external.rs`, `observability/`. Grep for callers. The caller count
   will be much higher than security's 47 — models are referenced
   everywhere.
2. **Workspace shell already exists** — skip phase 2 entirely.
3. **Extract**:
   - Move the files into `crates/wayve-core/src/`
   - The prelude re-exports become wayve-core's public surface
   - Collapse `wayve-security/src/config.rs` and `wayve-server/src/config.rs`
     into `wayve-core/src/config.rs`
   - Update wayve-security to depend on wayve-core
   - Update wayve-server to depend on wayve-core
   - `sed` rewrite all `crate::{prelude,models,config,external}` →
     `wayve_core::*` in wayve-server
4. **Validate** + remember to bump the Dockerfile cache mount id from
   `v1` to `v2`.

After wayve-core, **stop**. Three crates is enough to capture the real
benefits. Going further (wayve-mail, wayve-chat, wayve-drive) tends to
churn cross-crate boundaries every PR without enforcing anything useful.

---

## Operational notes

- **Binary name** is still `rwayve`. Don't rename it — the Dockerfile's
  `cp /app/target/release/rwayve` and the prod compose's command both
  expect this name.
- **`just` recipes** in `infra/justfile` that reference `backend/` paths
  still work — the workspace lives entirely under `backend/`.
- **`cargo test`** must now be `cargo test --workspace` to run all crates.
  The CI step in `.github/workflows/smoke.yml` may need updating if it
  doesn't already use `--workspace`.
- **Editor / rust-analyzer**: restart it after the layout change. It
  caches the old layout and will show false errors on `crate::security::X`
  references until restarted.
- **Production deploy**: nothing changes. The Docker build is rebuilt
  from scratch on EC2 using the same `scripts/deploy.sh` flow.

---

## Files changed (snapshot)

The refactor touched ~150 files across the backend, dominated by import
rewrites (`crate::security::X` → `wayve_security::X`). The conceptually
significant changes are concentrated in:

| File | Why it mattered |
|---|---|
| `backend/Cargo.toml` (new) | Workspace root, `[workspace.dependencies]` |
| `backend/crates/wayve-server/Cargo.toml` | Moved + reformatted to use workspace deps |
| `backend/crates/wayve-security/Cargo.toml` (new) | The new crate's manifest |
| `backend/crates/wayve-security/src/lib.rs` (new) | Public module tree |
| `backend/crates/wayve-security/src/config.rs` (new) | Local env helpers |
| `backend/crates/wayve-security/src/embed/middleware.rs` (new) | `EmbedPrincipal` lives here now |
| `backend/crates/wayve-security/src/password.rs` | New `PasswordError`, AppError dep removed |
| `backend/crates/wayve-server/src/error.rs` | Added `impl From<PasswordError> for AppError` |
| `backend/crates/wayve-server/src/embed/middleware.rs` | Re-exports `EmbedPrincipal` from wayve-security |
| `backend/crates/wayve-server/src/config.rs` | Dropped helpers that only security/ used |
| `backend/crates/wayve-server/src/main.rs` | Removed `pub mod security;` |
| `backend/Dockerfile` | Workspace-aware, versioned cache-mount id |
