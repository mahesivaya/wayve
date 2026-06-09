# Adding a feature

The repo is a modular monolith. Adding a feature is mechanical — follow the
checklists below. There is **one** route hub on each side; you never edit a giant
central list.

## Backend (Rust / Actix)

A feature is a module under `backend/crates/wayve-server/src/<feature>/` that owns
its handlers, models, and **its own route registration**.

1. **Create the module** `src/<feature>/mod.rs` (plus `handler.rs`, `models.rs`, …
   as needed). Handlers are `#[get]/#[post]/…` async fns returning `AppResult`
   (`use crate::prelude::*;`).
2. **Expose a `routes()`** in the module:
   ```rust
   pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
       cfg.service(create_thing).service(list_things);
   }
   ```
   Add `pub fn public_routes()` for unauthenticated routes and/or
   `pub fn ws_routes()` for WebSocket endpoints if the feature needs them
   (see `chat`, `email`, `billing`).
3. **Declare the module** — add `mod <feature>;` in
   [main.rs](../../backend/crates/wayve-server/src/main.rs).
4. **Wire it once** in [routing.rs](../../backend/crates/wayve-server/src/routing.rs)
   (the single route-wiring hub): add `.configure(<feature>::routes)` inside the
   `/api` scope (and `.configure(<feature>::public_routes)` / `ws_routes` at the
   root if present). **Nothing else registers routes.**

   > The cross-cutting "core platform" routes (auth, user/org, account, audit,
   > SSO, recovery, support…) live under `src/routes/`. Each domain there owns
   > its own `routes()`; `routes/mod.rs` just delegates to them. To add a core
   > endpoint, edit only that domain's submodule + its `routes()`.

5. **Background work?** Add it to `spawn_role_workers()` in
   [startup.rs](../../backend/crates/wayve-server/src/startup.rs) (the single
   place workers/subscribers start) — don't spawn ad-hoc in `main`. One-time
   process state goes in `startup::init_feature_state`.
6. **Schema?** Edit [infra/postgres/init.sql](../../infra/postgres/init.sql)
   (additive, `IF NOT EXISTS`) and reconcile prod via
   `scripts/apply-schema-prod.sh` — `init.sql` only auto-runs on a fresh volume.
7. **Tests** go in `src/tests/<feature>_test.rs`, wired via `mod <feature>_test;`
   in `src/tests/mod.rs` (see CLAUDE.md → Backend tests).

A great worked example of a *pluggable* sub-feature (no route edits at all) is the
mail-provider recipe at the top of
[email/provider.rs](../../backend/crates/wayve-server/src/email/provider.rs).

## Frontend (React / Vite)

1. **Create the folder** `frontend/src/<feature>/` with the page component
   (`<Feature>.tsx`) + co-located css/types/hooks.
2. **API calls** go in `frontend/src/api/<feature>.ts` using `apiFetch` /
   `apiFetchJson` from [api/client.ts](../../frontend/src/api/client.ts).
3. **Register the page:**
   - **Sidebar split-pane app?** Add ONE entry to `SPLIT_APPS` in
     [components/LayoutConfig.ts](../../frontend/src/components/LayoutConfig.ts).
     That single entry adds both the sidebar item **and** its route (App.tsx
     generates `<Route>`s from `SPLIT_APPS`). Set `autoRoute: false` only if the
     route needs a guard/redirect — then declare that route by hand in
     [App.tsx](../../frontend/src/App.tsx).
   - **Plain protected page (not in the sidebar)?** Add a `lazy()` import + a
     `<Route>` inside the `<Layout/>` block in
     [App.tsx](../../frontend/src/App.tsx).
   - **Public page?** Add the `<Route>` above the `ProtectedRoute` block.
4. **Tests** go in `frontend/src/test/<feature>/` (Vitest + Testing Library).

> Note: there are **no** stale `.js` siblings under `frontend/src` (all removed);
> `resolve.extensions` in `vite.config.ts` / `vitest.config.ts` also prefers
> `.ts(x)` defensively. Don't commit compiled `.js` next to sources.
