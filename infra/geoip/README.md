# GeoIP database (offline IP geolocation)

The **User Logs** page (`/logs/users`) shows a **Location** (city, state, country)
for each audited event. The backend resolves it from the request IP using an
offline `.mmdb` (MaxMind DB binary format) database — no third-party API calls.

This directory is mounted read-only into the backend container at `/app/geoip`,
and the backend reads `GEOIP_DB_PATH` (set to `/app/geoip/GeoLite2-City.mmdb` in
the compose files). The `maxminddb` reader accepts any `.mmdb` in that format, so
either of the databases below works at that path.

## Which database

- **DB-IP IP-to-City Lite** — free, **no account required**, downloadable directly
  (`https://download.db-ip.com/free/dbip-city-lite-<YYYY-MM>.mmdb.gz`). Licensed
  **CC-BY 4.0**, so if the Location data is shown publicly you must attribute
  DB-IP (https://db-ip.com). This is currently what's installed here.
- **MaxMind GeoLite2-City** — also free but requires a MaxMind account; same
  `.mmdb` format, drop-in compatible.

## Setup

1. Create a free MaxMind account: https://www.maxmind.com/en/geolite2/signup
2. Download **GeoLite2-City** in the `.mmdb` (MaxMind DB binary) format.
3. Place the file here as:

   ```
   infra/geoip/GeoLite2-City.mmdb
   ```

4. Restart the backend (`just docker-up` / redeploy).

## Notes

- **Best-effort.** If the file is absent or unreadable, the backend logs a
  warning at startup (`geoip database failed to load; geolocation disabled`) and
  the Location column simply stays blank — nothing else breaks.
- The `.mmdb` file is **license-restricted and large**, so it is **git-ignored**
  (see `.gitignore`) and must be provisioned out-of-band on each host.
- Only **public** IPs resolve; localhost/private IPs and rows written before the
  feature show `-`.
- Refresh periodically — MaxMind updates GeoLite2 a couple of times per week.
