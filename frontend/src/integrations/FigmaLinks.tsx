import { useEffect, useState } from "react";
import {
  createFigmaLink,
  deleteFigmaLink,
  listFigmaLinks,
  type FigmaLink,
  type FigmaLinkOwner,
} from "../api/figma";
import "./figmaPanel.css";

// The designs attached to one ticket or user story, with a box to paste another.
//
// Metadata is captured once when the link is made, so drawing this costs no
// Figma call — the cards render from what the board already stored. Adding one
// does hit Figma, using the caller's own token, which is what stops anyone
// attaching a file they couldn't already open.
export default function FigmaLinks({ owner }: { owner: FigmaLinkOwner }) {
  const [links, setLinks] = useState<FigmaLink[] | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerKey = owner.ticketId ?? owner.userStoryId;
  useEffect(() => {
    let cancelled = false;
    void listFigmaLinks(owner)
      .then((rows) => {
        if (!cancelled) setLinks(rows);
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the item's id: the owner object is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);

  const add = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const link = await createFigmaLink(trimmed, owner);
      setLinks((prev) => [...(prev ?? []), link]);
      setUrl("");
    } catch (e) {
      // The backend distinguishes a bad link, an unreadable file, and a missing
      // connection; each message is already the useful one.
      setError(e instanceof Error ? e.message : "Could not attach that design.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    const previous = links;
    setLinks((prev) => (prev ?? []).filter((l) => l.id !== id));
    try {
      await deleteFigmaLink(id);
    } catch {
      setLinks(previous ?? null); // put it back; nothing was removed
      setError("Could not remove that design.");
    }
  };

  return (
    <div className="figma-links">
      {links && links.length > 0 && (
        <>
          {links.map((link) => (
            <div key={link.id} className="figma-link-card">
              <a
                className="figma-link-card"
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                style={{ border: "none", padding: 0, flex: "1 1 auto" }}
              >
                {link.thumbnail_url ? (
                  <img
                    className="figma-link-thumb"
                    src={link.thumbnail_url}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <span className="figma-link-thumb" aria-hidden="true" />
                )}
                <span className="figma-link-body">
                  <span className="figma-link-name">{link.name}</span>
                  <span className="figma-link-meta">
                    {link.node_id ? "Frame · " : "File · "}
                    {link.file_modified_at
                      ? `edited ${new Date(link.file_modified_at).toLocaleDateString()}`
                      : "Figma"}
                  </span>
                </span>
              </a>
              <button
                type="button"
                className="figma-link-remove"
                onClick={() => void remove(link.id)}
                aria-label={`Remove ${link.name}`}
              >
                Remove
              </button>
            </div>
          ))}
        </>
      )}

      <div className="figma-row">
        <input
          className="slack-input"
          type="url"
          placeholder="Paste a Figma link…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button
          type="button"
          className="figma-btn"
          onClick={() => void add()}
          disabled={busy || !url.trim()}
        >
          {busy ? "Attaching…" : "Attach"}
        </button>
      </div>

      {error && <p className="figma-error">{error}</p>}
    </div>
  );
}
