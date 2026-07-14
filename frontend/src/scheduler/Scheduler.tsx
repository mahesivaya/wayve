import { logger } from "../utils/logger";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { PersonIcon } from "../icons";
import "./scheduler.css";
import { computeLanes } from "./eventLayout";
import Modal from "../components/Modal";
import {
  createMeetingApi,
  deleteMeetingApi,
  getMeetings,
  updateMeetingApi,
} from "../api/scheduler";
import { useGlobalSearch } from "../search/SearchContext";
import { getChatUsers, type ChatUser } from "../api/chat";
import {
  CALENDAR_COLORS,
  CALENDAR_STORAGE_KEY,
  DAY_SLOTS,
  SLOT_MINUTES,
  DEFAULT_CALENDARS,
  DEFAULT_VISIBLE_START_HOUR,
  EVENT_CALENDAR_STORAGE_KEY,
} from "./constants";
import {
  addMinutesToTime,
  formatDateLocal,
  formatHour,
  fromTime,
  nowTimeStr,
  todayStr,
  toMinutes,
  toTime,
} from "./dateUtils";
import { readJson, writeJson } from "./storage";
import { APP_TIME_ZONE } from "../utils/datetime";
import { useInSplitPane } from "../components/SplitPaneContext";
import type { CalendarItem, SchedulerView } from "./types";

type SchedulerEvent = {
  id: number;
  title: string;
  date: string;
  start: number;
  end: number;
  participants: string[];
  zoom_join_url: string | null;
  source: string;
};

type ApiMeeting = {
  id: number;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  participants?: string[] | null;
  zoom_join_url?: string | null;
  source?: string | null;
};

type CreatedMeeting = {
  meeting_id?: number;
};

type TimeOption = { value: string; label: string };

function TimeSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: TimeOption[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Scroll the selected row into view on open, so the user lands near their
  // existing pick instead of at midnight.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const selected =
      listRef.current.querySelector<HTMLLIElement>("li.is-selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const current = options.find((opt) => opt.value === value);

  return (
    <div className="time-select" ref={wrapRef}>
      <button
        type="button"
        className="time-select-button"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{current?.label ?? value}</span>
        <span className="time-select-caret">▾</span>
      </button>
      {open && (
        <ul className="time-select-list" role="listbox" ref={listRef}>
          {options.map((opt) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={opt.value === value ? "is-selected" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(opt.value);
                setOpen(false);
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

export default function Scheduler() {
  const { normalizedSearchQuery } = useGlobalSearch();
  const daySlotsRef = useRef<HTMLDivElement>(null);
  const weekGridRef = useRef<HTMLDivElement>(null);

  // Narrowness is measured on the container, not the viewport, so the scheduler
  // collapses correctly inside a split pane.
  const schedulerRootRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const el = schedulerRootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const narrow = entry.contentRect.width < 640;
        setIsNarrow((prev) => (prev !== narrow ? narrow : prev));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A split pane is always too narrow for the sidebar plus the 7-column week, so
  // it collapses unconditionally; elsewhere the width measurement decides.
  const inSplitPane = useInSplitPane();
  const collapsed = isNarrow || inSplitPane;

  const [view, setView] = useState<SchedulerView>("week");

  // Collapsing defaults the view to a single day, but only on the transition, so
  // the Week button still works afterwards.
  useEffect(() => {
    if (collapsed) {
      setView((v) => (v === "week" ? "day" : v));
    }
  }, [collapsed]);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [events, setEvents] = useState<SchedulerEvent[]>([]);
  const [calendars, setCalendars] = useState<CalendarItem[]>(() =>
    readJson(CALENDAR_STORAGE_KEY, DEFAULT_CALENDARS)
  );
  const [eventCalendars, setEventCalendars] = useState<Record<string, string>>(
    () => readJson(EVENT_CALENDAR_STORAGE_KEY, {})
  );
  const [newCalendarName, setNewCalendarName] = useState("");

  const [showModal, setShowModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<SchedulerEvent | null>(null);

  const [title, setTitle] = useState("");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [selectedDate, setSelectedDate] = useState(
    formatDateLocal(currentDate)
  );
  const [selectedCalendarId, setSelectedCalendarId] = useState("office");

  const [participants, setParticipants] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  // People directory for the participant typeahead. /api/users/all returns only
  // the caller's own org members, so suggestions never cross tenants.
  const [directory, setDirectory] = useState<ChatUser[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);

  useEffect(() => {
    let alive = true;
    getChatUsers()
      .then((users) => {
        if (alive) setDirectory(users);
      })
      .catch(() => {
        // Best-effort: without the directory the field still accepts typed
        // emails, it just won't suggest matches.
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    writeJson(CALENDAR_STORAGE_KEY, calendars);
  }, [calendars]);

  useEffect(() => {
    writeJson(EVENT_CALENDAR_STORAGE_KEY, eventCalendars);
  }, [eventCalendars]);

  const deleteMeeting = async () => {
    if (!editingEvent) return;

    const confirmDelete = confirm("Delete this meeting?");
    if (!confirmDelete) return;

    try {
      await deleteMeetingApi(editingEvent.id);

      setShowModal(false);
      setEditingEvent(null);
      await fetchMeetings();
    } catch (err) {
      logger.log("❌ Delete error", err);
    }
  };

  const slots = DAY_SLOTS;

  const scrollToDefaultVisibleTime = useCallback(
    (targetView = view) => {
      const scrollTarget = DEFAULT_VISIBLE_START_HOUR * 2 * 44;
      const target =
        targetView === "day" ? daySlotsRef.current : weekGridRef.current;
      if (target) {
        target.scrollTop = scrollTarget;
      }
    },
    [view]
  );

  const queueDefaultTimeScroll = useCallback(
    (targetView = view) => {
      window.requestAnimationFrame(() =>
        scrollToDefaultVisibleTime(targetView)
      );
    },
    [scrollToDefaultVisibleTime, view]
  );

  useEffect(() => {
    if (view === "day" || view === "week") {
      queueDefaultTimeScroll(view);
    }
  }, [view, currentDate, queueDefaultTimeScroll]);

  const getCalendarIdForEvent = (event: SchedulerEvent) => {
    if (event.source === "google") return "holiday";
    return eventCalendars[String(event.id)] ?? "office";
  };

  const getCalendarForEvent = (event: SchedulerEvent) => {
    const calendarId = getCalendarIdForEvent(event);
    return (
      calendars.find((calendar) => calendar.id === calendarId) ?? calendars[0]
    );
  };

  const createCalendar = () => {
    const name = newCalendarName.trim();
    if (!name) return;

    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    const color = CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length];

    setCalendars((prev) => [...prev, { id, name, color, visible: true }]);
    setSelectedCalendarId(id);
    setNewCalendarName("");
  };

  const toggleCalendar = (calendarId: string) => {
    setCalendars((prev) =>
      prev.map((calendar) =>
        calendar.id === calendarId
          ? { ...calendar, visible: !calendar.visible }
          : calendar
      )
    );
  };

  // Directory people whose email matches what's typed and who aren't already
  // added. An empty query shows the first few, so the list is browsable on focus.
  const participantSuggestions = useMemo(() => {
    const query = emailInput.trim().toLowerCase();
    const chosen = new Set(participants.map((p) => p.toLowerCase()));
    const pool = directory.filter((u) => !chosen.has(u.email.toLowerCase()));
    const matched = query
      ? pool.filter((u) => u.email.toLowerCase().includes(query))
      : pool;
    return matched.slice(0, 8);
  }, [emailInput, directory, participants]);

  const addParticipant = (explicit?: string) => {
    const email = (explicit ?? emailInput).trim().toLowerCase();

    if (!email) return;

    if (!email.includes("@") || !email.includes(".")) {
      alert("Enter a valid email");
      return;
    }

    if (!participants.includes(email)) {
      setParticipants([...participants, email]);
    }

    setEmailInput("");
    setShowSuggestions(false);
    setActiveSuggestion(0);
  };

  const onParticipantKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setShowSuggestions(true);
      setActiveSuggestion((i) =>
        Math.min(i + 1, participantSuggestions.length - 1)
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestion((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = participantSuggestions[activeSuggestion];
      addParticipant(pick ? pick.email : emailInput);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  const removeParticipant = (email: string) => {
    setParticipants(participants.filter((p) => p !== email));
  };

  const fetchMeetings = useCallback(async () => {
    const data = (await getMeetings()) as ApiMeeting[];

    const formatted = data.map((m) => ({
      id: m.id,
      title: m.title,
      date: m.date,
      start: fromTime(m.start_time),
      end: fromTime(m.end_time),
      participants: m.participants ?? [],
      zoom_join_url: m.zoom_join_url ?? null,
      source: m.source ?? "wayve",
    }));

    setEvents(formatted);
  }, []);

  useEffect(() => {
    void fetchMeetings();
  }, [fetchMeetings]);

  const saveMeeting = async () => {
    const startMins = toMinutes(start);
    const endMins = toMinutes(end);

    if (!editingEvent) {
      const nowMins = toMinutes(nowTimeStr());
      if (
        selectedDate < todayStr() ||
        (selectedDate === todayStr() && startMins <= nowMins)
      ) {
        alert("Cannot create a meeting in the past");
        return;
      }
    }
    if (endMins <= startMins) {
      alert("End time must be after start time");
      return;
    }

    // An overlap with an existing event on the same date warns but is allowed.
    // The event being edited is excluded so it can't conflict with itself.
    // Intervals [a1,a2) and [b1,b2) overlap iff a1 < b2 && b1 < a2.
    const conflicts = events.filter((existing) => {
      if (editingEvent && existing.id === editingEvent.id) return false;
      if (existing.date !== selectedDate) return false;
      return startMins < existing.end && existing.start < endMins;
    });
    if (conflicts.length > 0) {
      const summary = conflicts
        .map(
          (c) =>
            `• "${c.title}" (${formatHour(c.start)} – ${formatHour(c.end)})`
        )
        .join("\n");
      const proceed = window.confirm(
        `This meeting conflicts with ${
          conflicts.length === 1
            ? "an existing event"
            : `${conflicts.length} existing events`
        }:\n\n${summary}\n\nCreate anyway?`
      );
      if (!proceed) return;
    }

    const finalParticipants = [...participants];

    // Auto-add an email that was typed but never confirmed with Enter.
    const email = emailInput.trim().toLowerCase();
    if (email && email.includes("@") && email.includes(".")) {
      if (!finalParticipants.includes(email)) {
        finalParticipants.push(email);
      }
    }

    logger.log(" sending participants:", finalParticipants);

    const payload = {
      title,
      date: selectedDate,
      start: startMins,
      end: endMins,
      participants: finalParticipants,
    };

    if (editingEvent) {
      await updateMeetingApi(editingEvent.id, payload);
      setEventCalendars((prev) => ({
        ...prev,
        [String(editingEvent.id)]: selectedCalendarId,
      }));
    } else {
      const created = (await createMeetingApi(payload)) as CreatedMeeting;
      if (created?.meeting_id) {
        setEventCalendars((prev) => ({
          ...prev,
          [String(created.meeting_id)]: selectedCalendarId,
        }));
      }
    }

    resetModal();
    void fetchMeetings();
  };

  const resetModal = () => {
    setShowModal(false);
    setEditingEvent(null);
    setTitle("");
    setParticipants([]);
    setSelectedCalendarId("office");
  };

  // Snap to the nearest 15-minute boundary so the value always matches one of
  // the dropdown options.
  const snap15 = (time: string) => {
    const mins = toMinutes(time);
    const snapped = Math.min(Math.round(mins / 15) * 15, 23 * 60 + 45);
    return toTime(snapped);
  };

  const openEdit = (event: SchedulerEvent) => {
    setEditingEvent(event);

    setTitle(event.title);
    setSelectedDate(event.date);
    setStart(snap15(toTime(event.start)));
    setEnd(snap15(toTime(event.end)));
    setSelectedCalendarId(getCalendarIdForEvent(event));
    setParticipants(event.participants ?? []);
    setEmailInput("");

    setShowModal(true);
  };

  const openCreate = (date?: string, startTime?: string) => {
    setEditingEvent(null);
    setTitle("");
    setParticipants([]);
    setSelectedCalendarId(
      calendars.find((calendar) => calendar.visible)?.id ?? "office"
    );
    setEmailInput("");
    const baseStart = snap15(startTime ?? nowTimeStr());
    setSelectedDate(date ?? todayStr());
    setStart(baseStart);
    setEnd(addMinutesToTime(baseStart, startTime ? 30 : 60));
    setShowModal(true);
  };

  const openDay = (date: Date) => {
    setCurrentDate(date);
    setView("day");
    queueDefaultTimeScroll("day");
  };

  const visibleEvents = normalizedSearchQuery
    ? events.filter((event) =>
        [
          event.title,
          event.date,
          event.source,
          event.zoom_join_url ?? "",
          ...(event.participants ?? []),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery)
      )
    : events;
  const calendarVisibleEvents = visibleEvents.filter((event) => {
    const calendar = getCalendarForEvent(event);
    return calendar?.visible ?? true;
  });
  // Per-day lane assignment for overlapping events: each event id maps to its
  // `lane` (0-indexed column) and `laneCount` (max concurrent events in its
  // overlap cluster), which positions conflicting events side by side.
  const lanesByDay = useMemo(() => {
    const byDate = new Map<string, typeof calendarVisibleEvents>();
    for (const event of calendarVisibleEvents) {
      const list = byDate.get(event.date) ?? [];
      list.push(event);
      byDate.set(event.date, list);
    }
    const map = new Map<string, ReturnType<typeof computeLanes>>();
    for (const [date, list] of byDate) {
      map.set(date, computeLanes(list));
    }
    return map;
  }, [calendarVisibleEvents]);

  // 15-minute slots across the day. Start hides past slots when scheduling for
  // today, and End only offers slots strictly after the chosen start, so the
  // dropdowns can't produce an invalid range. The current start/end are always
  // included so the controlled select never loses its value.
  const timeSlots = useMemo(() => {
    const slots: { value: string; label: string; mins: number }[] = [];
    for (let m = 0; m < 24 * 60; m += 15) {
      slots.push({ value: toTime(m), label: formatHour(m), mins: m });
    }
    return slots;
  }, []);

  const startOptions = useMemo(() => {
    const minMins =
      !editingEvent && selectedDate === todayStr()
        ? toMinutes(nowTimeStr())
        : -1;
    const startMins = toMinutes(start);
    return timeSlots.filter((s) => s.mins > minMins || s.mins === startMins);
  }, [timeSlots, editingEvent, selectedDate, start]);

  const endOptions = useMemo(() => {
    const startMins = toMinutes(start);
    const endMins = toMinutes(end);
    return timeSlots.filter((s) => s.mins > startMins || s.mins === endMins);
  }, [timeSlots, start, end]);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const changeMonth = (offset: number) => {
    const newDate = new Date(currentDate);
    newDate.setMonth(newDate.getMonth() + offset);
    setCurrentDate(newDate);
  };

  const weekStart = new Date(currentDate);
  weekStart.setDate(currentDate.getDate() - currentDate.getDay());
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + i);
    return day;
  });

  return (
    <div
      className={`scheduler${collapsed ? " narrow" : ""}`}
      ref={schedulerRootRef}
    >
      <div className="scheduler-sidebar">
        <button className="scheduler-create-main" onClick={() => openCreate()}>
          <span>＋</span>
          Create
        </button>

        <div className="mini-header">
          <button onClick={() => changeMonth(-1)}>◀</button>
          <span>
            {currentDate.toLocaleDateString("en-US", {
              timeZone: APP_TIME_ZONE,
              month: "long",
              year: "numeric",
            })}
          </span>
          <button onClick={() => changeMonth(1)}>▶</button>
        </div>

        <div className="mini-weekdays">
          {["S", "M", "T", "W", "T", "F", "S"].map((day, index) => (
            <span key={`${day}-${index}`}>{day}</span>
          ))}
        </div>

        <div className="mini-calendar">
          {[...Array(daysInMonth)].map((_, i) => {
            const day = i + 1;
            const d = new Date(year, month, day);

            const isActive = d.toDateString() === currentDate.toDateString();

            return (
              <div
                key={i}
                className={`mini-day ${isActive ? "active" : ""}`}
                onClick={() => {
                  setCurrentDate(d);
                  setView("day");
                  queueDefaultTimeScroll("day");
                }}
              >
                {day}
              </div>
            );
          })}
        </div>

        <div className="calendar-create-box">
          <input
            value={newCalendarName}
            onChange={(e) => setNewCalendarName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createCalendar();
            }}
            placeholder="New calendar"
          />
          <button onClick={createCalendar}>＋</button>
        </div>

        <div className="calendar-section">
          <div className="calendar-section-title">My calendars</div>
          {calendars.map((calendar) => (
            <label key={calendar.id} className="calendar-toggle">
              <input
                type="checkbox"
                checked={calendar.visible}
                onChange={() => toggleCalendar(calendar.id)}
              />
              <span
                className="calendar-color"
                style={{
                  borderColor: calendar.color,
                  background: calendar.visible ? calendar.color : "transparent",
                }}
              />
              <span>{calendar.name}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="calendar">
        <div className="calendar-header">
          {collapsed && (
            <button className="create-btn" onClick={() => openCreate()}>
              ＋ Create
            </button>
          )}
          <button
            onClick={() => {
              setCurrentDate(new Date());
              setView("day");
              queueDefaultTimeScroll("day");
            }}
          >
            Today
          </button>
          <button onClick={() => changeMonth(-1)}>‹</button>
          <button onClick={() => changeMonth(1)}>›</button>
          {!collapsed || view === "month" ? (
            <div className="calendar-title">
              {currentDate.toLocaleDateString("en-US", {
                timeZone: APP_TIME_ZONE,
                month: "long",
                year: "numeric",
              })}
            </div>
          ) : (
            <div className="calendar-title-spacer" />
          )}
          <button
            onClick={() => {
              setView("day");
              queueDefaultTimeScroll("day");
            }}
          >
            Day
          </button>
          <button
            onClick={() => {
              setView("week");
              queueDefaultTimeScroll("week");
            }}
          >
            Week
          </button>
          <button onClick={() => setView("month")}>Month</button>
        </div>

        {view === "day" && (
          <div className="day-view">
            <h3 className="day-title">{currentDate.toDateString()}</h3>

            <div className="day-slots" ref={daySlotsRef}>
              {slots.map((slot) => {
                const mins = slot * SLOT_MINUTES;

                const timeLabel = `${Math.floor(mins / 60)
                  .toString()
                  .padStart(2, "0")}:${(mins % 60)
                  .toString()
                  .padStart(2, "0")}`;

                const dayDate = formatDateLocal(currentDate);

                const slotEvents = calendarVisibleEvents.filter(
                  (e) =>
                    e.date === dayDate &&
                    e.start >= mins &&
                    e.start < mins + SLOT_MINUTES
                );

                return (
                  <div
                    key={slot}
                    className="time-row"
                    onClick={() => openCreate(dayDate, timeLabel)}
                  >
                    <div className="time-label">{timeLabel}</div>

                    <div className="time-events">
                      {slotEvents.map((e) =>
                        (() => {
                          const calendar = getCalendarForEvent(e);
                          // Blocks are sized by duration, so a 30-minute event
                          // spans half a slot. `top` is the sub-hour offset, and
                          // `left`/`width` split the column into N lanes when N
                          // events overlap.
                          const durationSlots =
                            (e.end - e.start) / SLOT_MINUTES;
                          const topFraction =
                            (e.start % SLOT_MINUTES) / SLOT_MINUTES;
                          const layout = lanesByDay.get(e.date)?.get(e.id) ?? {
                            lane: 0,
                            laneCount: 1,
                          };
                          const leftPct =
                            (layout.lane / layout.laneCount) * 100;
                          const widthPct = 100 / layout.laneCount;
                          return (
                            <div
                              key={e.id}
                              className={`event${e.source === "google" ? " from-google" : ""}`}
                              style={{
                                background: calendar?.color,
                                top: `calc(${topFraction} * var(--slot-h, 48px))`,
                                height: `calc(${durationSlots} * var(--slot-h, 48px) - 4px)`,
                                left: `calc(${leftPct}% + 2px)`,
                                width: `calc(${widthPct}% - 4px)`,
                              }}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                openEdit(e);
                              }}
                            >
                              {e.title}
                            </div>
                          );
                        })()
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {view === "week" && (
          <div className="week-view">
            <div className="week-header">
              <div className="time-spacer">Time</div>
              {weekDays.map((d, i) => {
                const isToday = formatDateLocal(d) === todayStr();

                return (
                  <div
                    key={i}
                    className={`week-day-header${isToday ? " is-today" : ""}`}
                  >
                    <span className="week-day-name">
                      {d
                        .toLocaleDateString("en-US", {
                          timeZone: APP_TIME_ZONE,
                          weekday: "short",
                        })
                        .toUpperCase()}
                    </span>
                    <span className="week-day-num">{d.getDate()}</span>
                  </div>
                );
              })}
            </div>

            <div className="week-grid" ref={weekGridRef}>
              {slots.map((slot) => {
                const mins = slot * SLOT_MINUTES;

                return (
                  <div key={slot} className="week-row">
                    <div className="time-label">
                      {Math.floor(mins / 60)
                        .toString()
                        .padStart(2, "0")}
                      :{(mins % 60).toString().padStart(2, "0")}
                    </div>

                    {[...Array(7)].map((_, i) => {
                      const d = weekDays[i];

                      const dayDate = formatDateLocal(d);
                      const slotTime = `${Math.floor(mins / 60)
                        .toString()
                        .padStart(2, "0")}:${(mins % 60)
                        .toString()
                        .padStart(2, "0")}`;

                      const slotEvents = calendarVisibleEvents.filter(
                        (e) =>
                          e.date === dayDate &&
                          e.start >= mins &&
                          e.start < mins + SLOT_MINUTES
                      );

                      return (
                        <div
                          key={i}
                          className="week-cell"
                          onClick={() => openCreate(dayDate, slotTime)}
                        >
                          {slotEvents.map((e) =>
                            (() => {
                              const calendar = getCalendarForEvent(e);
                              // Same duration-based sizing and lane split as the
                              // day view above.
                              const durationSlots =
                                (e.end - e.start) / SLOT_MINUTES;
                              const topFraction =
                                (e.start % SLOT_MINUTES) / SLOT_MINUTES;
                              const layout = lanesByDay
                                .get(e.date)
                                ?.get(e.id) ?? { lane: 0, laneCount: 1 };
                              const leftPct =
                                (layout.lane / layout.laneCount) * 100;
                              const widthPct = 100 / layout.laneCount;
                              return (
                                <div
                                  key={e.id}
                                  className={`event${e.source === "google" ? " from-google" : ""}`}
                                  style={{
                                    background: calendar?.color,
                                    top: `calc(${topFraction} * var(--slot-h, 48px))`,
                                    height: `calc(${durationSlots} * var(--slot-h, 48px) - 4px)`,
                                    left: `calc(${leftPct}% + 2px)`,
                                    width: `calc(${widthPct}% - 4px)`,
                                  }}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    openEdit(e);
                                  }}
                                >
                                  <span className="event-title">{e.title}</span>
                                  <span className="event-time">
                                    {formatHour(e.start)} - {formatHour(e.end)}
                                  </span>
                                </div>
                              );
                            })()
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {view === "month" && (
          <div className="month-view">
            <div className="month-weekday-row">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="month-weekday">
                  {d}
                </div>
              ))}
            </div>
            <div className="month-grid">
              {[...Array(new Date(year, month, 1).getDay())].map((_, i) => (
                <div key={`pad-${i}`} className="day-cell empty" />
              ))}
              {[...Array(daysInMonth)].map((_, i) => {
                const cellDate = new Date(year, month, i + 1);
                const dayDate = formatDateLocal(cellDate);
                const isToday = dayDate === todayStr();
                return (
                  <div
                    key={i}
                    className={`day-cell${isToday ? " is-today" : ""}`}
                    onClick={() => openDay(cellDate)}
                  >
                    <div className="date">{i + 1}</div>
                    <div className="events">
                      {(() => {
                        // Cap the chips per cell so a busy day renders "+N more"
                        // instead of ballooning past the grid. The link opens
                        // that day's Day view, where every event is visible.
                        const MAX_VISIBLE = 3;
                        const dayEvents = calendarVisibleEvents
                          .filter((e) => e.date === dayDate)
                          .sort((a, b) => a.start - b.start);
                        const hidden = dayEvents.length - MAX_VISIBLE;
                        return (
                          <>
                            {dayEvents.slice(0, MAX_VISIBLE).map((e) => {
                              const calendar = getCalendarForEvent(e);
                              return (
                                <div
                                  key={e.id}
                                  className={`event${e.source === "google" ? " from-google" : ""}`}
                                  style={{ background: calendar?.color }}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    openEdit(e);
                                  }}
                                >
                                  <span className="event-time">
                                    {Math.floor(e.start / 60)}:
                                    {(e.start % 60).toString().padStart(2, "0")}
                                  </span>
                                  <span className="event-title">{e.title}</span>
                                </div>
                              );
                            })}
                            {hidden > 0 && (
                              <button
                                type="button"
                                className="month-more"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  openDay(cellDate);
                                }}
                              >
                                +{hidden} more
                              </button>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Modal
        isOpen={showModal}
        onClose={resetModal}
        title={editingEvent ? "Edit Meeting" : "Schedule Meeting"}
      >
        <div className="form">
          <div className="form-group">
            <label>Date</label>
            <input
              type="date"
              value={selectedDate}
              min={editingEvent ? undefined : todayStr()}
              onChange={(e) => {
                const v = e.target.value;
                if (!editingEvent && v && v < todayStr()) {
                  setSelectedDate(todayStr());
                } else {
                  setSelectedDate(v);
                }
              }}
            />
          </div>

          <div className="form-group">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="form-group">
            <label>Calendar</label>
            <select
              value={selectedCalendarId}
              onChange={(e) => setSelectedCalendarId(e.target.value)}
            >
              {calendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Participants</label>
            <div className="chips">
              {participants.map((p) => (
                <div key={p} className="chip">
                  {p}
                  <span onClick={() => removeParticipant(p)}>×</span>
                </div>
              ))}
            </div>
            <div className="participant-input">
              <div className="participant-typeahead">
                <input
                  type="text"
                  placeholder="Type a name or email…"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                    setShowSuggestions(true);
                    setActiveSuggestion(0);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() =>
                    window.setTimeout(() => setShowSuggestions(false), 120)
                  }
                  onKeyDown={onParticipantKeyDown}
                  role="combobox"
                  aria-expanded={
                    showSuggestions && participantSuggestions.length > 0
                  }
                  aria-autocomplete="list"
                />
                {showSuggestions && participantSuggestions.length > 0 && (
                  <ul className="participant-suggestions" role="listbox">
                    {participantSuggestions.map((u, idx) => (
                      <li
                        key={u.id}
                        role="option"
                        aria-selected={idx === activeSuggestion}
                        className={idx === activeSuggestion ? "is-active" : ""}
                        onMouseEnter={() => setActiveSuggestion(idx)}
                        onMouseDown={(e) => {
                          // mousedown (not click) so it fires before the input's
                          // blur hides the list.
                          e.preventDefault();
                          addParticipant(u.email);
                        }}
                      >
                        <span className="participant-suggestion-avatar">
                          <PersonIcon size={16} />
                        </span>
                        <span className="participant-suggestion-email">
                          {u.email}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="button" onClick={() => addParticipant()}>
                Add
              </button>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Start</label>
              <TimeSelect
                value={start}
                options={startOptions}
                onChange={(v) => {
                  setStart(v);
                  if (toMinutes(end) <= toMinutes(v)) {
                    setEnd(addMinutesToTime(v, 30));
                  }
                }}
              />
            </div>

            <div className="form-group">
              <label>End</label>
              <TimeSelect
                value={end}
                options={endOptions}
                onChange={(v) => setEnd(v)}
              />
            </div>
          </div>

          {editingEvent?.zoom_join_url && (
            <div className="form-group">
              <label>Zoom link</label>
              <a
                href={editingEvent.zoom_join_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {editingEvent.zoom_join_url}
              </a>
            </div>
          )}
        </div>

        <div className="modal-actions">
          {editingEvent && (
            <button className="delete-btn" onClick={deleteMeeting}>
              Delete
            </button>
          )}
          <button onClick={saveMeeting}>
            {editingEvent ? "Update" : "Save"}
          </button>
          <button onClick={resetModal}>Cancel</button>
        </div>
      </Modal>
    </div>
  );
}
