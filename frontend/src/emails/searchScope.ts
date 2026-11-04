import { STUB_EMAIL_FOLDERS, type EmailFolder } from "./types";

// All mail leaves these out, so a search started in one of them stays there:
// it is the only way to search what they hold.
const SEARCHED_IN_PLACE: ReadonlyArray<EmailFolder> = [
  "spam",
  "drafts",
  "trash",
];

// The places a search can look, as offered by the search box's options menu.
export const SEARCH_SCOPES: ReadonlyArray<{
  folder: EmailFolder;
  label: string;
}> = [
  { folder: "all", label: "All mail" },
  { folder: "spam", label: "Spam" },
  { folder: "drafts", label: "Drafts" },
  { folder: "trash", label: "Trash" },
];

// Where a search started from this folder looks.
export function searchScope(folder: EmailFolder): EmailFolder {
  return SEARCHED_IN_PLACE.includes(folder) ? folder : "all";
}

// The folder a list request reads. A search covers all mail, as in Gmail, so
// archived and filter-skipped messages, which no other folder lists, can still
// be found. Clearing the search returns to the folder itself.
export function listFolder(folder: EmailFolder, query: string): EmailFolder {
  return query.trim() && !SEARCHED_IN_PLACE.includes(folder) ? "all" : folder;
}

// A stub folder lists nothing and must not fetch: the server would answer with
// all mail, which select-all could then act on behind the placeholder. A search
// from one still reads all mail, like a search from any other folder.
export function isStubView(folder: EmailFolder, query: string): boolean {
  return !query.trim() && STUB_EMAIL_FOLDERS.includes(folder);
}
