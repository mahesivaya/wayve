import { apiFetch } from "./client";

// "Connect with Fluxze" consent calls. The SPA consent page reads a pending
// authorization by its request_id and posts the user's Allow/Deny decision; the
// backend returns the URL to send the browser back to the requesting app.

export type OAuthConsent = {
  app_name: string;
  app_homepage: string | null;
  scopes: string[];
  redirect_uri: string;
};

export async function getOAuthConsent(
  requestId: string
): Promise<OAuthConsent> {
  const res = await apiFetch(
    `/api/oauth/consent/${encodeURIComponent(requestId)}`,
    { preserve401: true }
  );
  return res.json();
}

export async function decideOAuthConsent(
  requestId: string,
  approve: boolean
): Promise<{ redirect_to: string }> {
  const res = await apiFetch(
    `/api/oauth/consent/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      preserve401: true,
      body: JSON.stringify({ approve }),
    }
  );
  return res.json();
}
