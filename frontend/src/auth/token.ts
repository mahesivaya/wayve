let inMemoryToken: string | null = null;

// Coalesces "session expired" notifications: concurrent 401s should trigger a
// single soft logout, not a storm. Reset whenever a fresh token is set (a new
// login), so a later genuine expiry still notifies.
let sessionExpiredNotified = false;

export const getAuthToken = () => inMemoryToken;

export const setAuthToken = (token: string) => {
  inMemoryToken = token;
  sessionExpiredNotified = false;
};

export const clearAuthToken = () => {
  inMemoryToken = null;
  localStorage.removeItem("token");
};

// Returns true only for the first caller after the last successful login —
// used to fire the `rwayve:session-expired` event exactly once per expiry.
export const noteSessionExpiredOnce = (): boolean => {
  if (sessionExpiredNotified) return false;
  sessionExpiredNotified = true;
  return true;
};
