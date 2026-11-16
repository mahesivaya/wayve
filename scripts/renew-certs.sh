#!/usr/bin/env bash
# scripts/renew-certs.sh — Renew the prod Let's Encrypt cert and reload nginx.
#
# The prod cert (fluxze.com, with www.fluxze.com, hadalspace.com and
# www.hadalspace.com as SANs) lives in the
# `rwayve_prod_letsencrypt_certs` Docker volume; nginx (rwayve_nginx_prod)
# reads it and serves the ACME HTTP-01 challenge from the
# `rwayve_prod_certbot_webroot` volume at /.well-known/acme-challenge/.
#
# `certbot renew` is a no-op until ~30 days before expiry, so this is safe to
# run frequently (we schedule it twice daily via cron). nginx is reloaded
# afterwards (zero-downtime) so it picks up a freshly renewed cert.
#
# Adding a name to the cert (once, on the prod host, after its DNS points at
# this box and nginx is serving it on port 80):
#   docker run --rm \
#     -v rwayve_prod_letsencrypt_certs:/etc/letsencrypt \
#     -v rwayve_prod_certbot_webroot:/var/www/certbot \
#     certbot/certbot certonly --webroot -w /var/www/certbot \
#     --cert-name fluxze.com --expand \
#     -d fluxze.com -d www.fluxze.com -d hadalspace.com -d www.hadalspace.com
#   docker exec rwayve_nginx_prod nginx -s reload
#
# Cron install (on the prod host, once):
#   (crontab -l 2>/dev/null; echo "17 3,15 * * * /home/ubuntu/rwayve/scripts/renew-certs.sh >> /home/ubuntu/rwayve/logs/cert-renew.log 2>&1") | crontab -
set -euo pipefail

CERTS_VOL="${CERTS_VOL:-rwayve_prod_letsencrypt_certs}"
WEBROOT_VOL="${WEBROOT_VOL:-rwayve_prod_certbot_webroot}"
NGINX_CONTAINER="${NGINX_CONTAINER:-rwayve_nginx_prod}"

echo "[$(date -u +%FT%TZ)] certbot renew starting"

# --webroot/-w is already recorded in each cert's renewal config, but we pass
# it explicitly so a manual run behaves identically. --quiet suppresses output
# unless something actually happens or errors.
docker run --rm \
  -v "${CERTS_VOL}:/etc/letsencrypt" \
  -v "${WEBROOT_VOL}:/var/www/certbot" \
  certbot/certbot renew --webroot -w /var/www/certbot --quiet

# Reload nginx regardless — it's a cheap, zero-downtime reload and guarantees a
# renewed cert is loaded without tracking whether certbot actually rotated it.
if docker ps --format '{{.Names}}' | grep -qx "${NGINX_CONTAINER}"; then
  docker exec "${NGINX_CONTAINER}" nginx -s reload
  echo "[$(date -u +%FT%TZ)] nginx reloaded"
else
  echo "[$(date -u +%FT%TZ)] WARN: ${NGINX_CONTAINER} not running; skipped reload"
fi

echo "[$(date -u +%FT%TZ)] certbot renew done"
