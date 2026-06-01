export const SEARCH_LABELS: Record<string, string> = {
  "/home": "home",
  "/emails": "all emails",
  "/emails/attachments": "email files",
  "/chat": "users and messages",
  "/call": "calls",
  "/scheduler": "meetings",
  "/drive": "files",
  "/notes": "notes",
  "/tasks": "tasks",
  "/ai-chat": "AI chat",
  "/profile": "profile",
  "/settings": "settings",
  "/security/audit": "security audit logs",
};

export const HIDE_SEARCH_PATHS = ["/scheduler"];

export const getSearchLabel = (path: string) => SEARCH_LABELS[path] ?? "this page";

export const shouldHideSearch = (path: string) => HIDE_SEARCH_PATHS.includes(path);
