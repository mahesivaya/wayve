import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatHour, parseTimeInput, toMinutes } from "./dateUtils";

type TimeOption = { value: string; label: string };

const DAY_END_MINUTES = 23 * 60 + 59;

export default function TimeSelect({
  id,
  value,
  options,
  onChange,
  minMins = -1,
}: {
  id: string;
  value: string;
  options: TimeOption[];
  onChange: (next: string) => void;
  // Exclusive lower bound, mirroring the filter applied to `options` so a typed
  // time can't slip past a constraint the list already enforces.
  minMins?: number;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // null = "follow the selection"; set only once the user arrows/hovers, so the
  // highlight tracks the filtered list without an effect re-seeding it.
  const [activeOverride, setActiveOverride] = useState<number | null>(null);
  const [dropUp, setDropUp] = useState(false);
  const [listMaxHeight, setListMaxHeight] = useState(240);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentLabel =
    options.find((opt) => opt.value === value)?.label ??
    formatHour(toMinutes(value));

  const isAllowed = useCallback(
    (time: string) => {
      const mins = toMinutes(time);
      return mins > minMins && mins <= DAY_END_MINUTES;
    },
    [minMins]
  );

  // Typing filters the presets; an untouched draft (still the current label)
  // shows the whole list so the caret behaves like a plain dropdown.
  const query = draft.trim().toLowerCase();
  const filtered =
    !query || query === currentLabel.toLowerCase()
      ? options
      : options.filter((opt) =>
          opt.label.toLowerCase().replace(/\s/g, "").includes(query.replace(/\s/g, ""))
        );

  const parsed = query && query !== currentLabel.toLowerCase() ? parseTimeInput(draft) : null;
  const customOption: TimeOption | null =
    parsed && isAllowed(parsed) && !filtered.some((opt) => opt.value === parsed)
      ? { value: parsed, label: formatHour(toMinutes(parsed)) }
      : null;
  const rows = customOption ? [customOption, ...filtered] : filtered;
  const invalid =
    Boolean(query) && query !== currentLabel.toLowerCase() && !rows.length;

  // A custom time isn't one of the presets, so fall back to the first slot at or
  // after it — the list still opens where the user left off.
  const exactIndex = rows.findIndex((opt) => opt.value === value);
  const selectedIndex =
    exactIndex >= 0
      ? exactIndex
      : rows.findIndex((opt) => toMinutes(opt.value) >= toMinutes(value));
  const activeIndex =
    activeOverride !== null && activeOverride < rows.length
      ? activeOverride
      : Math.max(selectedIndex, 0);

  const openList = () => {
    if (open) return;
    setDraft(currentLabel);
    setActiveOverride(null);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setDraft("");
    setActiveOverride(null);
  };

  const commit = (next: string) => {
    onChange(next);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // The list is absolutely positioned inside the modal's scroll box, so it gets
  // clipped rather than overflowing it. Measure the room left above and below
  // the field and drop whichever way actually fits.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const host =
      wrapRef.current.closest(".modal-body") ?? document.documentElement;
    const hostRect = host.getBoundingClientRect();
    const below = hostRect.bottom - rect.bottom - 10;
    const above = rect.top - hostRect.top - 10;
    const up = below < 150 && above > below;
    setDropUp(up);
    setListMaxHeight(Math.max(120, Math.min(240, up ? above : below)));
  }, [open]);

  // Land on the current pick instead of at midnight.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const active = listRef.current.querySelector<HTMLLIElement>("li.is-active");
    active?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (!rows.length) return;
      const next = event.key === "ArrowDown" ? activeIndex + 1 : activeIndex - 1;
      setActiveOverride((next + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = rows[activeIndex];
      if (picked) {
        commit(picked.value);
        return;
      }
      const typed = parseTimeInput(draft);
      if (typed && isAllowed(typed)) commit(typed);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      inputRef.current?.blur();
    }
  };

  const onBlur = () => {
    if (!open) return;
    const typed = parseTimeInput(draft);
    if (typed && isAllowed(typed) && typed !== value) {
      commit(typed);
    } else {
      close();
    }
  };

  return (
    <div className={`time-select${open ? " is-open" : ""}`} ref={wrapRef}>
      <input
        id={id}
        ref={inputRef}
        type="text"
        className={`time-select-input${invalid ? " is-invalid" : ""}`}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        aria-activedescendant={
          open && rows[activeIndex] ? `${id}-opt-${activeIndex}` : undefined
        }
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="e.g. 10:45 AM"
        value={open ? draft : currentLabel}
        onChange={(e) => {
          setDraft(e.target.value);
          setActiveOverride(null);
          if (!open) setOpen(true);
        }}
        onFocus={(e) => {
          openList();
          e.target.select();
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <button
        type="button"
        className="time-select-caret"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) {
            close();
          } else {
            inputRef.current?.focus();
          }
        }}
      >
        ▾
      </button>
      {open && rows.length > 0 && (
        <ul
          id={`${id}-listbox`}
          className={`time-select-list${dropUp ? " is-up" : ""}`}
          style={{ maxHeight: listMaxHeight }}
          role="listbox"
          ref={listRef}
        >
          {rows.map((opt, idx) => (
            <li
              key={opt.value}
              id={`${id}-opt-${idx}`}
              role="option"
              aria-selected={opt.value === value}
              className={[
                opt.value === value ? "is-selected" : "",
                idx === activeIndex ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onMouseEnter={() => setActiveOverride(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(opt.value);
              }}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
