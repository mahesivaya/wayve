import { apiFetchJson } from "./client";

// `key` is null for installs that did not report that field.
export type MobileKeyCount = { key: string | null; count: number };

// All three null means installs whose IP could not be located.
export type MobileLocationCount = {
  country: string | null;
  region: string | null;
  city: string | null;
  count: number;
};

export type MobileInstallRow = {
  id: number;
  platform: string;
  channel: string | null;
  app_version: string | null;
  build: string | null;
  os_version: string | null;
  device_model: string | null;
  user_id: number | null;
  user_email: string | null;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  launches: number;
  first_seen_at: string;
  last_seen_at: string;
};

export type MobileInstallStats = {
  total: number;
  active_30_days: number;
  new_30_days: number;
  by_platform: MobileKeyCount[];
  by_channel: MobileKeyCount[];
  by_version: MobileKeyCount[];
  by_location: MobileLocationCount[];
  recent: MobileInstallRow[];
};

export async function getMobileInstallStats(
  limit = 200
): Promise<MobileInstallStats> {
  return apiFetchJson<MobileInstallStats>(
    `/api/platform/mobile-installs?limit=${limit}`,
    { preserve401: true }
  );
}
