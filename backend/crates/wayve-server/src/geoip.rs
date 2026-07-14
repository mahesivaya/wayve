//! Offline IP geolocation via a MaxMind GeoLite2-City database.
//!
//! Best-effort, like the Redis cache: the reader loads once at startup and is
//! shared read-only as `web::Data<Option<GeoIp>>`. When `GEOIP_DB_PATH` is unset
//! or unreadable, state holds `None`, every lookup degrades to an empty
//! [`GeoLocation`], and the User Logs "Location" column just stays blank.
//!
//! The `.mmdb` is license-restricted and large, so it is not committed; it is
//! mounted into the container and pointed at by `GEOIP_DB_PATH`.

use std::net::IpAddr;

use maxminddb::{Reader, geoip2};
use tracing::{info, warn};

/// A resolved coarse location. A private or unknown IP, or a database miss,
/// yields the all-`None` default.
#[derive(Debug, Default, Clone)]
pub struct GeoLocation {
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
}

/// A loaded GeoLite2-City reader. The backing buffer is owned, so the reader is
/// self-contained and cheap to share behind the `Arc` inside `web::Data`.
pub struct GeoIp {
    reader: Reader<Vec<u8>>,
}

impl GeoIp {
    /// Open the `.mmdb` at `path`. `None` (logged) on any failure, so the caller
    /// can keep running without geolocation.
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

    /// Resolve `ip` to a coarse city, region, and country. Never errors: a
    /// malformed IP or a lookup miss returns the default [`GeoLocation`].
    pub fn lookup(&self, ip: &str) -> GeoLocation {
        let Ok(addr) = ip.parse::<IpAddr>() else {
            return GeoLocation::default();
        };
        // A miss is `Ok(None)` and a malformed database is `Err`; both degrade to
        // the empty location.
        let Ok(found) = self.reader.lookup(addr) else {
            return GeoLocation::default();
        };
        let Ok(Some(record)) = found.decode::<geoip2::City>() else {
            return GeoLocation::default();
        };
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
