import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { EMOJI_CATEGORIES, searchEmojis } from "../emoji";

type Props = {
  /** Called with the chosen glyph (e.g. "🎉"). The picker does not close itself. */
  onSelect: (char: string) => void;
  onClose: () => void;
  /**
   * The wrapper that holds both this popover and the button that opens it.
   * Clicks anywhere inside it are "inside" — otherwise a click on the open
   * button would dismiss the picker here and immediately reopen it in the
   * button's own handler.
   */
  anchorRef: RefObject<HTMLElement | null>;
};

// The composer's emoji popover: a search box over a categorized grid. Rendered
// only while open, so the whole thing (including its document-level dismiss
// listener) unmounts when closed.
export default function EmojiPicker({ onSelect, onClose, anchorRef }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");

  // Dismiss on a click anywhere outside the anchor. `mousedown` (not `click`)
  // so the picker is gone before the click lands, matching the mention menu's
  // mousedown convention elsewhere in the composer.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchorRef, onClose]);

  const results = searchEmojis(query);
  const searching = query.trim().length > 0;

  return (
    <div
      className="chat-emoji-picker"
      ref={rootRef}
      role="dialog"
      aria-label="Emoji picker"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <input
        className="chat-emoji-search"
        type="search"
        // The picker is opened by an explicit click, so taking focus here is
        // what the user asked for — they can type to filter straight away.
        autoFocus
        placeholder="Search emoji"
        aria-label="Search emoji"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="chat-emoji-scroll">
        {searching ? (
          results.length === 0 ? (
            <p className="chat-emoji-empty">No emoji for “{query.trim()}”</p>
          ) : (
            <div className="chat-emoji-grid">
              {results.map((e) => (
                <button
                  key={e.char}
                  type="button"
                  className="chat-emoji-btn"
                  title={e.name}
                  aria-label={e.name}
                  onClick={() => onSelect(e.char)}
                >
                  {e.char}
                </button>
              ))}
            </div>
          )
        ) : (
          EMOJI_CATEGORIES.map((cat) => (
            <section key={cat.id} className="chat-emoji-section">
              <h4 className="chat-emoji-heading">{cat.label}</h4>
              <div className="chat-emoji-grid">
                {cat.emojis.map((e) => (
                  <button
                    key={e.char}
                    type="button"
                    className="chat-emoji-btn"
                    title={e.name}
                    aria-label={e.name}
                    onClick={() => onSelect(e.char)}
                  >
                    {e.char}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
