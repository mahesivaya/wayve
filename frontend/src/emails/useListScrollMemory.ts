import { useLayoutEffect, type RefObject } from "react";

// Scroll offsets outlive the element they came from, so they can't live in a
// ref inside the list: in list view, opening an email unmounts the whole list
// pane (see `showList` in Emails.tsx) and Back mounts a fresh one. The rows
// themselves survive — they're held by useEmailInbox on the page — so only the
// scroll position needs carrying across, keyed by which list was showing.
const positions = new Map<string, number>();

// Typing in the search box mints a new key per keystroke. Nothing here is
// expensive, but the map shouldn't grow for the life of the tab either; Map
// iterates in insertion order, so the oldest entry is the first one out.
const MAX_KEYS = 24;

function remember(key: string, top: number) {
  positions.set(key, top);
  if (positions.size > MAX_KEYS) {
    const oldest = positions.keys().next();
    if (!oldest.done) positions.delete(oldest.value);
  }
}

/**
 * Restores `ref`'s scroll offset when a list remounts under the same `key`, and
 * keeps it current while the user scrolls.
 *
 * A layout effect, not a plain one: the rows are already in the DOM by the time
 * effects run, so restoring before paint means the list never flashes at the
 * top on the way back from an email.
 *
 * `key` identifies *which* list is on screen (account + folder + search). A
 * different key is a different set of rows, which correctly starts at the top
 * rather than inheriting an offset that meant something else.
 */
export function useListScrollMemory(
  ref: RefObject<HTMLElement | null>,
  key: string
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const saved = positions.get(key);
    // A saved offset past the end of a list that has since shrunk is clamped by
    // the browser, which lands the user at the bottom — the closest thing to
    // where they were.
    if (saved) el.scrollTop = saved;

    const onScroll = () => remember(key, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      // The listener has been tracking all along; this catches the final value
      // for the case where unmount follows a scroll too closely to have fired.
      remember(key, el.scrollTop);
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref, key]);
}

// Test seam: the store is module state by design, which would otherwise leak
// between test cases in the same file.
export function __resetListScrollMemory() {
  positions.clear();
}
