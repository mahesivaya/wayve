#!/usr/bin/env bash
# scripts/deploy.sh — Deploy rwayve to the production EC2 instance.
#
# Default flow: pulls the CI-built images from ECR (tagged with the deployed
# commit's short SHA) and runs `docker compose up -d --no-build`. The GitHub
# Actions workflow `.github/workflows/build-images.yml` must have already built
# and pushed the images for the commit being deployed — deploy aborts if the
# tags aren't in ECR yet (wait for CI to go green, then re-run).
#
# Escape hatch: `BUILD_ON_HOST=1` reverts to the old build-on-the-box flow
# (`up -d --build`), for when CI is unavailable.
#
# Usage:
#   ./scripts/deploy.sh                 # deploy origin/main from ECR images
#   BRANCH=feature/foo ./scripts/deploy.sh
#   BUILD_ON_HOST=1 ./scripts/deploy.sh # build on the EC2 instead of pulling
#
# Requirements on the laptop:
#   - ssh + curl
#   - SSH key at $SSH_KEY (default: ~/.ssh/rwayve-deploy.pem)
#
# Requirements on the EC2 (already provisioned):
#   - ~/rwayve checked out
#   - Docker + Compose installed
#   - AWS CLI installed and an instance role with ECR read
#     (AmazonEC2ContainerRegistryReadOnly) — used to log in and pull images
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
AWS_REGION="${AWS_REGION:-us-east-1}"
BUILD_ON_HOST="${BUILD_ON_HOST:-0}"

if [ ! -f "$SSH_KEY" ]; then
  echo "SSH key not found at $SSH_KEY" >&2
  exit 1
fi

echo "==> Deploying branch '$BRANCH' to $INSTANCE_USER@$INSTANCE_HOST"
if [ "$BUILD_ON_HOST" = "1" ]; then
  echo "    Mode: build-on-host (BUILD_ON_HOST=1)"
else
  echo "    Mode: pull from ECR (region $AWS_REGION)"
fi

ssh -o StrictHostKeyChecking=accept-new -i "$SSH_KEY" "$INSTANCE_USER@$INSTANCE_HOST" \
  REMOTE_DIR="$REMOTE_DIR" BRANCH="$BRANCH" \
  COMPOSE_FILE="$COMPOSE_FILE" ENV_FILE="$ENV_FILE" \
  AWS_REGION="$AWS_REGION" BUILD_ON_HOST="$BUILD_ON_HOST" \
  bash -se <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"

echo "    Pulling $BRANCH..."
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git reset --quiet --hard "origin/$BRANCH"
# Full 40-char SHA to match the CI image tag exactly. `--short` is
# machine-dependent in length (see build-images.yml) and could look for a tag
# CI never pushed.
SHA=$(git rev-parse HEAD)
echo "    HEAD: $(git rev-parse --short HEAD) ($SHA)"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

if [ "$BUILD_ON_HOST" = "1" ]; then
  echo "    Building images on host..."
  compose up -d --build
else
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
  export BACKEND_IMAGE="$REGISTRY/rwayve-backend:$SHA"
  export FRONTEND_IMAGE="$REGISTRY/rwayve-frontend:$SHA"

  echo "    Verifying ECR images for $SHA exist..."
  for repo in rwayve-backend rwayve-frontend; do
    if ! aws ecr describe-images --region "$AWS_REGION" \
        --repository-name "$repo" --image-ids "imageTag=$SHA" >/dev/null 2>&1; then
      echo "    ERROR: $repo:$SHA not found in ECR." >&2
      echo "    The build workflow hasn't pushed this commit yet — wait for" >&2
      echo "    CI (build-images) to go green, or deploy with BUILD_ON_HOST=1." >&2
      exit 1
    fi
  done

  echo "    Logging in to ECR ($REGISTRY)..."
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY"

  echo "    Pulling images..."
  compose pull
  echo "    docker compose up -d --no-build..."
  compose up -d --no-build
fi

# nginx uses a stock image with a bind-mounted template processed by
# envsubst at container start. `up -d` doesn't recreate it on template
# changes, so force-recreate every deploy. ~2s nginx restart, no data loss.
echo "    Force-recreating nginx so envsubst picks up template changes..."
compose up -d --force-recreate --no-deps nginx

echo "    Services:"
compose ps
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
