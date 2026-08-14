import { useCallback, useEffect, useRef, useState } from "react";
import { searchContacts, type ContactSuggestion } from "../api/email";
import { activeMention } from "../shared/mentions";

const DEBOUNCE_MS = 180;
const MAX_SUGGESTIONS = 6;

/** Display label for a contact, used for the dropdown row's avatar initial. */
export function mentionLabel(c: ContactSuggestion): string {
  return c.display_name?.trim() || c.address;
}

type Args = {
  /** Current textarea value (e.g. the reply body). */
  value: string;
  /** Setter for the textarea value. */
  setValue: (next: string) => void;
  /** Ref to the textarea so the caret can be read and restored. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Called with the picked contact after the `@label` is spliced into the text. */
  onPick: (contact: ContactSuggestion) => void;
};

/**
 * Drives an `@mention` typeahead over a plain `<textarea>`, backed by the inbox
 * contacts search (matching email addresses you've corresponded with). Owns the
 * query/results/highlight state and returns the event handlers + render data the
 * component wires onto the textarea and menu.
 *
 * The text splice happens here; the caller's `onPick` runs afterward for
 * side-effects (e.g. adding the contact's address to a Cc list).
 */
export function useMentionSearch({ value, setValue, textareaRef, onPick }: Args) {
  const [query, setQuery] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [results, setResults] = useState<ContactSuggestion[]>([]);
  const [index, setIndex] = useState(0);
  // Guards against out-of-order async responses clobbering a newer query.
  const reqId = useRef(0);

  // Debounced search whenever the active query changes. Deliberately never sets
  // state synchronously in the effect body — a short/empty query simply schedules
  // no fetch, and `open` below hides any now-stale results.
  useEffect(() => {
    if (query === null || query.trim().length < 2) return;
    const mine = ++reqId.current;
    const handle = setTimeout(() => {
      void searchContacts(query)
        .then((rows) => {
          if (mine === reqId.current) {
            setResults(rows.slice(0, MAX_SUGGESTIONS));
            setIndex(0);
          }
        })
        .catch(() => {
          if (mine === reqId.current) setResults([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const open =
    query !== null && query.trim().length >= 2 && results.length > 0;
  const highlighted = Math.min(index, results.length - 1);

  const syncFromCaret = useCallback((el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length;
    // Addresses allowed: filtering the contact list by typing a whole address
    // is the point of this typeahead.
    const mention = activeMention(el.value, caret, { allowAddress: true });
    if (mention) {
      setQuery(mention.query);
      setStart(mention.start);
    } else {
      setQuery(null);
    }
  }, []);

  const close = useCallback(() => {
    setQuery(null);
    setResults([]);
    reqId.current++;
  }, []);

  const apply = useCallback(
    (contact: ContactSuggestion) => {
      const el = textareaRef.current;
      const before = value.slice(0, start);
      const after = value.slice(start + 1 + (query ?? "").length);
      // The address, not the display name: it is what the row showed and what
      // was searched for, and unlike a name it contains no space, so the
      // inserted token can be re-detected if the caret returns to it.
      const insert = `@${contact.address} `;
      setValue(before + insert + after);
      close();
      onPick(contact);
      const caret = (before + insert).length;
      if (el) {
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(caret, caret);
        });
      }
    },
    [value, start, query, setValue, close, onPick, textareaRef]
  );

  /** Wire onto the textarea's `onKeyDown`. Returns true if it handled the key
   *  (the caller should then skip its own Enter-to-send handling). */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (i + 1) % results.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i - 1 + results.length) % results.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        apply(results[highlighted]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [open, results, highlighted, apply, close]
  );

  return {
    open,
    results,
    highlighted,
    setIndex,
    apply,
    syncFromCaret,
    onKeyDown,
    close,
  };
}
