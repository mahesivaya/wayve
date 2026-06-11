//! Offline IP geolocation via a MaxMind GeoLite2-City database.
//!
//! Best-effort, mirroring the Redis cache: the reader is loaded once at startup
//! and shared read-only as `web::Data<Option<GeoIp>>`. If `GEOIP_DB_PATH` is
//! unset or the file can't be read, app state holds `None` and every lookup
//! degrades to an empty [`GeoLocation`] — the app runs normally, the User Logs
//! "Location" column just stays blank.
//!
//! The `.mmdb` file is license-restricted (free MaxMind GeoLite2 account) and
//! large, so it is NOT committed; it's mounted into the container and pointed at
//! via `GEOIP_DB_PATH`.

use std::net::IpAddr;

use maxminddb::{Reader, geoip2};
use tracing::{info, warn};

/// A resolved coarse location. All fields optional: a private/unknown IP or a
/// database miss yields the default (all `None`).
#[derive(Debug, Default, Clone)]
pub struct GeoLocation {
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
}

/// A loaded GeoLite2-City reader. The backing buffer is owned (`Vec<u8>`) so the
/// reader is self-contained and cheap to share behind an `Arc` (`web::Data`).
pub struct GeoIp {
    reader: Reader<Vec<u8>>,
}

impl GeoIp {
    /// Open the `.mmdb` at `path`. Returns `None` (logged) on any failure so the
    /// caller can keep running without geolocation.
    pub fn open(path: &str) -> Option<Self> {
        match Reader::open_readfile(path) {
            Ok(reader) => {
                info!(target: "worker", path, "geoip database loaded");
                Some(Self { reader })
            }
            Err(err) => {
                warn!(target: "worker", path, error = ?err, "geoip database failed to load; geolocation disabled");
                None
            }
        }
    }

    /// Resolve `ip` to a coarse city/region/country. Never errors — a malformed
    /// IP or a lookup miss returns the default [`GeoLocation`].
    pub fn lookup(&self, ip: &str) -> GeoLocation {
        let Ok(addr) = ip.parse::<IpAddr>() else {
            return GeoLocation::default();
        };
        // 0.28 split lookup into two steps: `lookup` resolves the record's
        // position, `decode` deserializes it. A miss is `Ok(None)`; a malformed
        // database is `Err` — both degrade to the empty location.
        let Ok(found) = self.reader.lookup(addr) else {
            return GeoLocation::default();
        };
        let Ok(Some(record)) = found.decode::<geoip2::City>() else {
            return GeoLocation::default();
        };
        // Names are now typed fields (`names.english: Option<&str>`) rather than
        // a localized-name map, so the English name is a direct access.
        GeoLocation {
            country: record.country.names.english.map(str::to_string),
            region: record
                .subdivisions
                .first()
                .and_then(|s| s.names.english)
                .map(str::to_string),
            city: record.city.names.english.map(str::to_string),
        }
    }
}
