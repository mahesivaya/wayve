# Edge proxy: terminates public TLS for the whole stack (docker-compose
# prod + dev). The stock nginx image lags Alpine's security releases, so the
# OS packages are upgraded on top of it — the same treatment the frontend
# image gets. `scripts/deploy.sh` rebuilds this with `--pull --no-cache` on
# every deploy, so each one picks up the newest 1.31 base and today's Alpine
# patches; CI builds the `runtime` stage uncached for the Trivy scan.
#
# Config is not baked in: compose bind-mounts the envsubst template and the
# 50x page, which the stock image's entrypoint renders at start.
FROM nginx:1.31-alpine AS runtime

RUN apk upgrade --no-cache
