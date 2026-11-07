import { apiFetchJson } from "./client";

export type DesktopBuildCount = { build: string; count: number };

// All three null means downloads whose IP could not be located.
export type DesktopLocationCount = {
  country: string | null;
  region: string | null;
  city: string | null;
  count: number;
};

export type DesktopDownloadRow = {
  id: number;
  build: string;
  user_id: number | null;
  user_email: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  created_at: string;
};

export type DesktopDownloadStats = {
  total: number;
  unique_ips: number;
  last_30_days: number;
  by_build: DesktopBuildCount[];
  by_location: DesktopLocationCount[];
  recent: DesktopDownloadRow[];
};

export async function getDesktopDownloadStats(
  limit = 200
): Promise<DesktopDownloadStats> {
  return apiFetchJson<DesktopDownloadStats>(
    `/api/platform/desktop-downloads?limit=${limit}`,
    { preserve401: true }
  );
}
