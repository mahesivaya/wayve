# Deploy

Quick command reference for shipping code to prod (`rwayve.maheshg.me` on EC2).

For the longer narrative (AWS context, TLS setup, infra layout) see [ec2_prod_deployment.md](ec2_prod_deployment.md).

## One-shot full deploy (laptop)

```bash
# From your laptop — wraps git pull + compose up --build on the EC2
./scripts/deploy.sh
```

## Manual / partial deploys

SSH in:

```bash
ssh -i ~/.ssh/rwayve-deploy.pem ubuntu@rwayve.maheshg.me
```

Pull the new code (always step 1):

```bash
cd /home/ubuntu/rwayve
git pull --ff-only origin main
```

Pick the right rebuild scope:

| Change | Command |
|---|---|
| Backend (Rust) only | `docker compose -f infra/docker-compose.prod.yml up -d --build --force-recreate backend` |
| Backend + both workers (schema change) | `docker compose -f infra/docker-compose.prod.yml up -d --build --force-recreate backend email_sync_worker email_body_worker` |
| Frontend only | `docker compose -f infra/docker-compose.prod.yml up -d --build --force-recreate frontend` |
| Nginx config only | `docker compose -f infra/docker-compose.prod.yml up -d --build --force-recreate nginx` |
| Everything | `docker compose -f infra/docker-compose.prod.yml up -d --build` |

> **`--build` is mandatory** when source changed. `--force-recreate` alone reuses the old image and silently runs the previous binary.

## Pre-deploy DB snapshot

Take a snapshot for any schema-affecting deploy:

```bash
docker exec rwayve_postgres_prod pg_dump -U rwayve rwayve_prod \
  | gzip > /home/ubuntu/backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz
```

Scope to specific tables when the change is local:

```bash
docker exec rwayve_postgres_prod pg_dump -U rwayve \
  -t drive_files -t folders rwayve_prod \
  | gzip > /home/ubuntu/backups/pre-drive-rename-$(date +%Y%m%d-%H%M%S).sql.gz
```

## Verify after deploy

```bash
# Wait for backend healthy
for i in $(seq 1 60); do
  s=$(docker inspect -f '{{.State.Health.Status}}' rwayve_backend_prod 2>/dev/null)
  [ "$s" = "healthy" ] && echo "READY after ${i}s" && break
  sleep 1
done

# HTTP smoke
curl -s -o /dev/null -w "GET /            -> %{http_code}\n" https://rwayve.maheshg.me/
curl -s -o /dev/null -w "GET /api/config -> %{http_code}\n" https://rwayve.maheshg.me/api/config

# Backend logs for errors
docker logs rwayve_backend_prod --since 2m 2>&1 | grep -iE 'error|warn' | tail -20

# DB migration check (if applicable)
docker exec rwayve_postgres_prod psql -U rwayve rwayve_prod -c '\dt'
```

## Rollback

Code rollback (previous commit, rebuild):

```bash
cd /home/ubuntu/rwayve
git reset --hard <previous-good-sha>
docker compose -f infra/docker-compose.prod.yml up -d --build --force-recreate backend frontend
```

DB rollback (restore the snapshot you took):

```bash
gunzip < /home/ubuntu/backups/pre-deploy-<timestamp>.sql.gz \
  | docker exec -i rwayve_postgres_prod psql -U rwayve rwayve_prod
```

## One-liner from laptop (no SSH session)

```bash
ssh -i ~/.ssh/rwayve-deploy.pem ubuntu@rwayve.maheshg.me '
  cd /home/ubuntu/rwayve && \
  git pull --ff-only origin main && \
  docker compose -f infra/docker-compose.prod.yml up -d --build --force-recreate backend frontend
'
```

## Container names (quick reference)

- `rwayve_backend_prod` — Actix API server
- `rwayve_email_sync_worker_prod` — Gmail/Outlook sync (30s loop)
- `rwayve_email_body_worker_prod` — message body fetcher
- `rwayve_frontend_prod` — Vite-built React bundle, served by nginx inside the container
- `rwayve_nginx_prod` — public-facing nginx (443 + 80→443 redirect)
- `rwayve_postgres_prod` — Postgres 15 (volume `rwayve_prod_pgdata`)
- `rwayve_redis_prod` — Redis 7 (rate limits + monthly quota counters)
