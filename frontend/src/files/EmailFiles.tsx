import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  downloadEmailAttachment,
  getAllEmailAttachments,
  type EmailAttachment,
} from "../api/email";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import "./emailFiles.css";

function formatFileSize(size?: number | null) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function EmailFiles() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { normalizedSearchQuery } = useGlobalSearch();
  const [files, setFiles] = useState<EmailAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    getAllEmailAttachments()
      .then((data) => {
        if (mounted) setFiles(data);
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Failed to load files");
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const visibleFiles = normalizedSearchQuery
    ? files.filter((file) =>
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
      )
    : files;

  return (
    <div className="email-files-page">
      <div className="email-files-header">
        <h2>Email Files</h2>
        <button onClick={() => navigate("/emails")}>Back to emails</button>
      </div>

      {loading ? (
        <div className="email-files-empty">Loading files...</div>
      ) : error ? (
        <div className="email-files-error">{error}</div>
      ) : visibleFiles.length === 0 ? (
        <div className="email-files-empty">
          {normalizedSearchQuery ? "No files match your search" : "No attached files found"}
        </div>
      ) : (
        <div className="email-files-list">
          {visibleFiles.map((file) => (
            <button
              key={file.id}
              className="email-files-row"
              onClick={() => downloadEmailAttachment(file, user?.id ?? null)}
            >
              <span className="email-files-icon">📎</span>
              <span className="email-files-main">
                <span className="email-files-name">{file.filename}</span>
                <span className="email-files-meta">
                  {file.subject || "No subject"} · {file.sender || "Unknown sender"}
                </span>
              </span>
              <span className="email-files-size">{formatFileSize(file.size)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
