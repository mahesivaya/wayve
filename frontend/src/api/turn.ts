import { apiFetch } from "./client";
import { logger } from "../utils/logger";

const log = logger.scope("call");

// Cloudflare's `generate-ice-servers` returns this shape; `iceServers` may
// be a single object or an array depending on the version of the API.
type CloudflareTurnResponse = {
  iceServers: RTCIceServer | RTCIceServer[];
};

// When TURN isn't configured (503) or the request errors, fall back to a
// public STUN server. This keeps calls working between peers behind
// permissive NATs — they just won't traverse symmetric NATs.
const STUN_FALLBACK: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// Cache the credentials per-tab so repeated calls don't hit the backend (or
// Cloudflare) once per RTCPeerConnection. 8 minutes is comfortably under the
// 10-minute server-side TTL so we never hand out an already-expired cred.
const CACHE_TTL_MS = 8 * 60 * 1000;
let cache: { servers: RTCIceServer[]; expiresAt: number } | null = null;

export async function getIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.servers;
  }

  try {
    const response = await apiFetch("/api/turn/credentials");
    if (response.status === 503) {
      log.warn("TURN not configured on server, using STUN fallback");
      return STUN_FALLBACK;
    }
    const payload = (await response.json()) as CloudflareTurnResponse;
    const servers = Array.isArray(payload.iceServers)
      ? payload.iceServers
      : [payload.iceServers];
    cache = { servers, expiresAt: now + CACHE_TTL_MS };
    return servers;
  } catch (err) {
    log.warn("TURN credentials fetch failed, falling back to STUN", err);
    return STUN_FALLBACK;
  }
}

// Exposed for tests + the rare case where a freshly-rotated Cloudflare API
// token needs to take effect without reloading the tab.
export function clearIceServersCache() {
  cache = null;
}
