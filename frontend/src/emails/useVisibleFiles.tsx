import { useMemo, type ReactNode } from "react";

import type { EmailAttachment } from "../api/email";

/**
 * Search filter + the empty state the list should show when nothing survives
 * it. `uncheckedCount` counts emails whose bodies — and therefore attachments —
 * the body worker hasn't processed yet, which is what separates "still
 * importing" from "genuinely no attachments".
 */
export function useVisibleFiles({
  files,
  normalizedSearchQuery,
  accountCount,
  emailCount,
  uncheckedCount,
}: {
  files: EmailAttachment[];
  normalizedSearchQuery: string;
  accountCount: number;
  emailCount: number;
  uncheckedCount: number;
}) {
  const visibleFiles = useMemo(() => {
    if (!normalizedSearchQuery) return files;
    return files.filter((file) =>
      [
        file.filename,
        file.mime_type ?? "",
        file.subject ?? "",
        file.sender ?? "",
        file.receiver ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchQuery)
    );
  }, [files, normalizedSearchQuery]);

  const hasNoAccounts = accountCount === 0;
  const stillImporting =
    !hasNoAccounts && (emailCount === 0 || uncheckedCount > 0);
  const scannedSoFar = Math.max(emailCount - uncheckedCount, 0);

  let emptyMessage: ReactNode = "No attached files found";
  if (normalizedSearchQuery) {
    emptyMessage = "No files match your search";
  } else if (hasNoAccounts) {
    emptyMessage = "Connect an email account to see attachments here.";
  } else if (emailCount === 0) {
    emptyMessage = (
      <>
        We&apos;re still importing your inbox. Attachments will appear here as
        we find them.
      </>
    );
  } else if (uncheckedCount > 0) {
    emptyMessage = (
      <>
        Scanned {scannedSoFar} of {emailCount} email
        {emailCount === 1 ? "" : "s"} so far. More attachments may show up
        shortly.
      </>
    );
  }

  const progressNote =
    stillImporting && !normalizedSearchQuery ? (
      <div className="email-files-progress" role="status">
        Still scanning {uncheckedCount > 0 ? uncheckedCount : ""} email
        {uncheckedCount === 1 ? "" : "s"} for attachments — this list will
        update automatically.
      </div>
    ) : null;

  return { visibleFiles, emptyMessage, progressNote };
}
