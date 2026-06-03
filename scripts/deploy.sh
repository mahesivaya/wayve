#!/usr/bin/env bash
# scripts/deploy.sh — Deploy rwayve to the production EC2 instance.
#
# Pulls the chosen branch on the EC2 and runs `docker compose up -d --build`
# against infra/docker-compose.prod.yml. Designed to run from a laptop.
#
# Usage:
#   ./scripts/deploy.sh                 # deploy origin/main
#   BRANCH=feature/foo ./scripts/deploy.sh
#   SKIP_BUILD=1 ./scripts/deploy.sh    # skip --build (only restart from existing images)
#
# Requirements on the laptop:
#   - ssh + curl
#   - SSH key at $SSH_KEY (default: ~/.ssh/rwayve-deploy.pem)
#
# Requirements on the EC2 (already provisioned):
#   - ~/rwayve checked out
#   - Docker + Compose installed
#   - .env.production, backend/.env.production, infra/.env.production populated
#   - client_secret.json at repo root (stub or real)

set -euo pipefail

INSTANCE_USER="${INSTANCE_USER:-ubuntu}"
INSTANCE_HOST="${INSTANCE_HOST:-fluxze.com}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/rwayve-deploy.pem}"
BRANCH="${BRANCH:-main}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/rwayve}"
COMPOSE_FILE="infra/docker-compose.prod.yml"
ENV_FILE="infra/.env.production"

if [ ! -f "$SSH_KEY" ]; then
  echo "SSH key not found at $SSH_KEY" >&2
  exit 1
fi

BUILD_FLAG="--build"
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  BUILD_FLAG=""
fi

echo "==> Deploying branch '$BRANCH' to $INSTANCE_USER@$INSTANCE_HOST"

ssh -o StrictHostKeyChecking=accept-new -i "$SSH_KEY" "$INSTANCE_USER@$INSTANCE_HOST" \
  REMOTE_DIR="$REMOTE_DIR" BRANCH="$BRANCH" \
  COMPOSE_FILE="$COMPOSE_FILE" ENV_FILE="$ENV_FILE" BUILD_FLAG="$BUILD_FLAG" \
  bash -se <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"

echo "    Pulling $BRANCH..."
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git reset --quiet --hard "origin/$BRANCH"
echo "    HEAD: $(git rev-parse --short HEAD)"

echo "    docker compose up -d $BUILD_FLAG..."
# shellcheck disable=SC2086
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d $BUILD_FLAG

# nginx uses a stock image with a bind-mounted template processed by
# envsubst at container start. `up -d --build` doesn't recreate it on
# template changes, so force-recreate every deploy. ~2s nginx restart,
# no data loss.
echo "    Force-recreating nginx so envsubst picks up template changes..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate --no-deps nginx

echo "    Services:"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
REMOTE

echo ""
echo "==> Waiting for backend health (up to 60s)..."
for i in $(seq 1 12); do
  if curl -fsS --max-time 5 "http://$INSTANCE_HOST/api/health" >/dev/null 2>&1; then
    echo "    Backend healthy after ${i}x5s"
    curl -sS "http://$INSTANCE_HOST/api/health" && echo
    exit 0
  fi
  sleep 5
done

echo "    Backend did NOT respond on /api/health within 60s." >&2
echo "    Investigate with: ssh -i $SSH_KEY $INSTANCE_USER@$INSTANCE_HOST 'cd $REMOTE_DIR && docker compose -f $COMPOSE_FILE logs --tail=80 backend'" >&2
exit 1
