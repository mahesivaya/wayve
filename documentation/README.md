# Documentation directory

This directory holds **internal scratchpad notes** — shell-history excerpts,
SQL snippets, infrastructure IDs, and other personal references that may
have once contained credentials (now rotated, see comments in each file).

These notes are intentionally **NOT** published at `/docs` on the live site.
The `^documentation/` allowlist in [.gitleaks.toml](../.gitleaks.toml)
exists to silence secret-scanner hits on the historical revisions of the
same files.

## Where are the published docs?

The customer-facing documentation rendered by the [/docs portal](https://rwayve.maheshg.me/docs)
lives next to the backend code so it can be `include_str!`'d into the
release binary:

| Doc | Source path |
| --- | --- |
| Price Tiers & Event Producers | [backend/src/docs/price_tier.md](../backend/src/docs/price_tier.md) |

The published catalog is defined in [backend/src/docs/handler.rs](../backend/src/docs/handler.rs) —
adding a new `.md` file to that directory does **not** automatically publish
it. Edit the `CATALOG` in `handler.rs` to expose a new doc.

## Adding a new published doc

1. Drop the `.md` file in `backend/src/docs/`.
2. Add an entry to the `CATALOG` `Lazy<Vec<Doc>>` in
   `backend/src/docs/handler.rs`.
3. Rebuild the backend; the doc shows up at `/docs/<slug>` immediately.

This split is deliberate. The `documentation/` directory is a private
notebook; `backend/src/docs/` is a public surface. Mixing the two would
risk publishing scratchpad notes by accident.
