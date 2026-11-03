import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { readRepoScrolls, rememberRepoScrolls } from "./openRepoSession";

// The page itself doesn't scroll: these do, inside `.github-content`.
const PANEL = ".github-content > .github-panel";
const DESCRIPTION = ".github-description";
const FILE_TREE = ".github-file-list";
const FILE_PREVIEW = ".github-preview pre";
const SCROLLERS = [PANEL, DESCRIPTION, FILE_TREE, FILE_PREVIEW];

// Content arrives after the page does (a pull request's diffs, a file's text), and
// a scroller can't reach an offset until it's tall enough, so keep trying for a
// while. Clamping along the way must not overwrite the offset being restored.
const RETRY_MS = 100;
const RETRY_FOR_MS = 8000;
const SAVE_DELAY_MS = 150;

const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

// Remembers how far each scroller was scrolled and puts it back on return. `place`
// names what the panels are showing (a section, one pull request), and `file` the
// file in the preview; offsets are kept per each. `ready` holds restoring until the
// page's content can exist.
export function useRepoScroll({
  containerRef,
  userId,
  fullName,
  place,
  file,
  ready,
}: {
  containerRef: RefObject<HTMLElement | null>;
  userId: number | undefined;
  fullName: string;
  place: string;
  file: string | null;
  ready: boolean;
}) {
  const offsets = useRef<Record<string, number> | null>(null);
  const location = useRef({ place, file });
  // Scrollers still being restored, whose scroll events aren't the user's.
  const restoring = useRef(new Set<string>());

  useEffect(() => {
    location.current = { place, file };
    if (!ready) return;
    offsets.current ??= readRepoScrolls(userId, fullName);
    const saved = offsets.current;

    const keyFor = (selector: string) =>
      selector === FILE_PREVIEW ? `file:${file}` : `place:${place}`;
    const pending = new Map<string, number>();
    for (const selector of SCROLLERS) {
      const key = `${keyFor(selector)}|${selector}`;
      if (Object.hasOwn(saved, key) && saved[key] > 0) {
        pending.set(selector, saved[key]);
      }
    }
    restoring.current = new Set(pending.keys());
    if (pending.size === 0) return;

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt >= RETRY_FOR_MS) stop();
      else step();
    }, RETRY_MS);
    const stop = () => {
      window.clearInterval(timer);
      restoring.current.clear();
      for (const type of USER_SCROLL_EVENTS) {
        document.removeEventListener(type, stop, true);
      }
    };
    const step = () => {
      for (const [selector, top] of pending) {
        const el = containerRef.current?.querySelector(selector);
        if (!el) continue;
        el.scrollTop = top;
        if (Math.abs(el.scrollTop - top) <= 1) {
          pending.delete(selector);
          restoring.current.delete(selector);
        }
      }
      if (pending.size === 0) stop();
    };
    // Whatever the user does next wins over a restore still in progress.
    for (const type of USER_SCROLL_EVENTS) {
      document.addEventListener(type, stop, true);
    }
    step();
    return stop;
  }, [containerRef, file, fullName, place, ready, userId]);

  // Listening from the document, since the scrollers come and go with the section
  // and scroll events don't bubble.
  useEffect(() => {
    let saveTimer: number | undefined;
    const save = () => {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
      if (offsets.current) {
        rememberRepoScrolls(userId, fullName, offsets.current);
      }
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !containerRef.current?.contains(target)
      ) {
        return;
      }
      const selector = SCROLLERS.find((s) => target.matches(s));
      if (!selector || restoring.current.has(selector)) return;
      offsets.current ??= readRepoScrolls(userId, fullName);
      const where =
        selector === FILE_PREVIEW
          ? `file:${location.current.file}`
          : `place:${location.current.place}`;
      const key = `${where}|${selector}`;
      // Re-added so the most recent stay when old ones are dropped.
      delete offsets.current[key];
      offsets.current[key] = target.scrollTop;
      if (saveTimer === undefined) {
        saveTimer = window.setTimeout(save, SAVE_DELAY_MS);
      }
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      // Leaving the page must not lose the last scroll.
      if (saveTimer !== undefined) save();
    };
  }, [containerRef, fullName, userId]);
}
