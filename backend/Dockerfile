# syntax=docker/dockerfile:1.7
# Requires BuildKit. With docker-compose v2 it's enabled by default; if you
# use the legacy `docker-compose`, prefix builds with `DOCKER_BUILDKIT=1`.

# ---- Builder ----------------------------------------------------------------
FROM rust:1.95-slim-bookworm AS builder

WORKDIR /app

# pkg-config helps a few crates probe system libs even with rustls-tls; keep
# the apt set minimal to keep this layer small and cache-friendly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Copy the whole workspace and build in one pass. The previous Dockerfile
# tried a stub-then-real-source trick to prime the dep cache; that pattern
# is fragile with Cargo workspaces because the stub `lib.rs` caches empty
# rmeta files that the real build then picks up, producing spurious
# "unresolved import" errors. BuildKit's cargo-registry/git cache mount
# below preserves the heavy downloads between builds; that's where the
# real speedup comes from on an active dev loop.
COPY . .
# `id=` qualifies the cache mount so historical entries from the old
# single-crate layout (when this image had just `rwayve` in the root
# Cargo.toml) don't get reused with the workspace layout. Bump the
# version suffix any time the workspace's crate set changes in a way
# that would invalidate cached rmeta.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=rwayve-workspace-target-v1,target=/app/target \
    cargo build --release --workspace \
    && cp /app/target/release/rwayve /app/rwayve.bin

# ---- Runtime ----------------------------------------------------------------
# Slim runtime — tens of MB instead of ~1.5 GB for the full rust image.
FROM debian:bookworm-slim AS runtime

# ca-certificates for outbound TLS; curl for the container healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/rwayve.bin /app/rwayve

# Drop privileges: the binary doesn't need root for anything (port 8080
# is unprivileged, logs go to a bind-mounted /app/logs). A non-root
# runtime cuts container-escape blast radius and satisfies Trivy DS-0002.
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin app \
    && chown -R app:app /app
USER app

# Default RUST_LOG; override via env. Per-target file layers ignore this.
ENV RUST_LOG=info
EXPOSE 8080
CMD ["/app/rwayve"]
