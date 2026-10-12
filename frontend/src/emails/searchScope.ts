import type { EmailFolder } from "./types";

// All mail leaves these out, so a search started in one of them stays there:
// it is the only way to search what they hold.
const SEARCHED_IN_PLACE: ReadonlyArray<EmailFolder> = [
  "spam",
  "drafts",
  "trash",
];

// The folder a list request reads. A search covers all mail, as in Gmail, so
// archived and filter-skipped messages, which no other folder lists, can still
// be found. Clearing the search returns to the folder itself.
export function listFolder(folder: EmailFolder, query: string): EmailFolder {
  return query.trim() && !SEARCHED_IN_PLACE.includes(folder) ? "all" : folder;
}
