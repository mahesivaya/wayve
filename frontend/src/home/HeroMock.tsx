import { useEffect, useState } from "react";

/* Decorative-but-interactive product mockup for the landing hero. Auto-cycles
   through the app's tabs (each a distinct mini-screen) and also responds to
   clicks; hovering pauses the cycle. Purely visual — no real navigation. */

function MailScreen() {
  const mail = [
    {
      from: "Emily Carter",
      subject: "Q3 roadmap — final review before Friday",
      time: "9:24",
    },
    {
      from: "GitHub",
      subject: "[fluxze] PR #482 merged into main",
      time: "8:10",
    },
    {
      from: "Marco Rossi",
      subject: "Re: Q3 invoice — approved, payment sent",
      time: "Yest",
    },
    {
      from: "Camille Laurent",
      subject: "Re: Design sync notes + Figma link",
      time: "Yest",
    },
    {
      from: "Hannah Schmidt",
      subject: "Re: Shared the design pages with you",
      time: "Tue",
    },
    {
      from: "Yuki Tanaka",
      subject: "Re: Tokyo office launch plan",
      time: "Tue",
    },
    { from: "Vercel", subject: "Production deployment is live", time: "Mon" },
    {
      from: "Aarav Sharma",
      subject: "Re: Contract renewal — Q3 terms",
      time: "Mon",
    },
  ];
  return (
    <>
      {mail.map((m) => (
        <div key={m.subject} className="hx-mock-mail">
          <span className="hx-mock-mavatar">{m.from.charAt(0)}</span>
          <span className="hx-mock-lines">
            <span className="hx-mock-from">{m.from}</span>
            <span className="hx-mock-subject">{m.subject}</span>
          </span>
          <span className="hx-mock-time">{m.time}</span>
        </div>
      ))}
    </>
  );
}

function ChatScreen() {
  const channels = ["general", "engineering", "design"];
  const dms = [
    { name: "Daniel Reed", initial: "D", active: true, unread: 0 },
    { name: "Emily Carter", initial: "E", active: false, unread: 2 },
    { name: "Marco Rossi", initial: "M", active: false, unread: 0 },
  ];
  const msgs: Array<{ side: "them" | "me"; text: string }> = [
    { side: "them", text: "Did the prod deploy go out?" },
    { side: "me", text: "Yep — green across the board ✅" },
    { side: "them", text: "And the encrypted backups?" },
    { side: "me", text: "All AES-256, end to end." },
    { side: "them", text: "🔥 ship it" },
    { side: "me", text: "Posting the release notes now." },
    { side: "them", text: "Perfect — I'll loop in the team." },
  ];
  return (
    <div className="hx-mock-chat">
      <aside className="hx-mock-chat-list">
        <div className="hx-mock-chat-section">Channels</div>
        {channels.map((c) => (
          <div key={c} className="hx-mock-conv">
            <span className="hx-mock-conv-hash">#</span>
            <span className="hx-mock-conv-name">{c}</span>
          </div>
        ))}
        <div className="hx-mock-chat-section">Direct messages</div>
        {dms.map((d) => (
          <div
            key={d.name}
            className={`hx-mock-conv ${d.active ? "is-active" : ""}`}
          >
            <span className="hx-mock-conv-avatar">{d.initial}</span>
            <span className="hx-mock-conv-name">{d.name}</span>
            {d.unread > 0 && (
              <span className="hx-mock-conv-badge">{d.unread}</span>
            )}
          </div>
        ))}
      </aside>

      <div className="hx-mock-chat-main">
        <div className="hx-mock-chat-head">
          <span className="hx-mock-chat-peer">
            <span className="hx-mock-chat-pavatar">D</span>
            Daniel Reed
          </span>
          <span className="hx-mock-chat-actions">
            <span className="hx-mock-chat-call" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                width="15"
                height="15"
              >
                <path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.3 1.1.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.3 1l-2.2 2.2z" />
              </svg>
            </span>
            <span className="hx-mock-chat-call" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                width="15"
                height="15"
              >
                <path d="M4 7a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v2.2l4.4-2.9a.6.6 0 0 1 .9.5v10.4a.6.6 0 0 1-.9.5L15 14.8V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7z" />
              </svg>
            </span>
          </span>
        </div>
        <div className="hx-mock-chat-stream">
          {msgs.map((m, i) => (
            <div key={i} className={`hx-mock-bubble ${m.side}`}>
              {m.text}
            </div>
          ))}
        </div>
        <div className="hx-mock-chat-compose">
          <span className="hx-mock-chat-input">Message Daniel Reed…</span>
          <span className="hx-mock-chat-send" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M3 11l18-8-8 18-2-7-8-3z" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

function MeetScreen() {
  const days = [
    { dow: "MON", date: 1 },
    { dow: "TUE", date: 2 },
    { dow: "WED", date: 3 },
    { dow: "THU", date: 4 },
    { dow: "FRI", date: 5 },
  ];
  const hours = ["9", "10", "11", "12", "1", "2", "3"];
  const ROW = 56; // px per hour row
  // col = day index, start/span in hour-rows from 9:00.
  const events = [
    {
      col: 0,
      start: 0.5,
      span: 0.5,
      title: "Standup",
      time: "9:30",
      color: "blue",
    },
    {
      col: 0,
      start: 4,
      span: 1,
      title: "Roadmap sync",
      time: "1:00",
      color: "green",
    },
    {
      col: 1,
      start: 2,
      span: 1,
      title: "Design review",
      time: "11:00",
      color: "purple",
    },
    {
      col: 2,
      start: 1,
      span: 1.5,
      title: "Client call",
      time: "10:00",
      color: "blue",
    },
    {
      col: 3,
      start: 4,
      span: 1,
      title: "1:1 — Daniel",
      time: "1:00",
      color: "amber",
    },
    {
      col: 4,
      start: 5,
      span: 1,
      title: "Sprint planning",
      time: "2:00",
      color: "green",
    },
  ];
  return (
    <div className="hx-mock-week">
      <div className="hx-mock-week-top">
        <span className="hx-mock-cal-title">June 2026</span>
        <div className="hx-mock-week-views">
          <span>Day</span>
          <span className="is-active">Week</span>
          <span>Month</span>
        </div>
      </div>
      <div className="hx-mock-week-head">
        <span className="hx-mock-week-gutter" />
        {days.map((d) => (
          <span key={d.dow} className="hx-mock-week-dayhead">
            <b>{d.dow}</b>
            <span>{d.date}</span>
          </span>
        ))}
      </div>
      <div className="hx-mock-week-body">
        <div className="hx-mock-week-times">
          {hours.map((h) => (
            <span key={h} style={{ height: ROW }}>
              {h}
            </span>
          ))}
        </div>
        <div className="hx-mock-week-cols">
          {days.map((d, ci) => (
            <div key={d.dow} className="hx-mock-week-col">
              {hours.map((h) => (
                <span
                  key={h}
                  className="hx-mock-week-slot"
                  style={{ height: ROW }}
                />
              ))}
              {events
                .filter((e) => e.col === ci)
                .map((e, i) => (
                  <div
                    key={i}
                    className={`hx-mock-event ${e.color}`}
                    style={{ top: e.start * ROW, height: e.span * ROW - 4 }}
                  >
                    <b>{e.title}</b>
                    <span>{e.time}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DriveScreen() {
  const files = [
    { n: "Roadmap.pdf", s: "2.4 MB" },
    { n: "Brand.fig", s: "18 MB" },
    { n: "Q3-budget.xlsx", s: "412 KB" },
    { n: "Demo.mp4", s: "96 MB" },
    { n: "Logo.svg", s: "24 KB" },
    { n: "Notes.md", s: "8 KB" },
    { n: "Pitch-deck.key", s: "32 MB" },
    { n: "Contract.pdf", s: "120 KB" },
  ];
  return (
    <div className="hx-mock-files">
      {files.map((f) => (
        <div key={f.n} className="hx-mock-file">
          <span className="hx-mock-fico" />
          <span className="hx-mock-fname">{f.n}</span>
          <span className="hx-mock-fsize">{f.s}</span>
        </div>
      ))}
    </div>
  );
}

function NotesScreen() {
  const notes = [
    { t: "Standup notes", lines: 3 },
    { t: "Launch checklist", lines: 4 },
    { t: "Customer call — Acme", lines: 2 },
    { t: "Ideas backlog", lines: 3 },
    { t: "1:1 agenda — Daniel", lines: 2 },
    { t: "Release notes draft", lines: 3 },
  ];
  return (
    <div className="hx-mock-notes">
      {notes.map((n) => (
        <div key={n.t} className="hx-mock-note">
          <strong>{n.t}</strong>
          {Array.from({ length: n.lines }).map((_, i) => (
            <span key={i} className="hx-mock-noteline" />
          ))}
        </div>
      ))}
    </div>
  );
}

function TasksScreen() {
  const tasks = [
    { t: "Ship billing webhook", done: true },
    { t: "Review PR #482", done: true },
    { t: "Draft Q3 roadmap", done: false },
    { t: "Rotate API keys", done: false },
    { t: "Reply to Acme thread", done: false },
    { t: "Update status page", done: false },
    { t: "Prep release notes", done: false },
    { t: "Email Q3 investor update", done: false },
  ];
  return (
    <div className="hx-mock-tasks">
      {tasks.map((t) => (
        <div key={t.t} className="hx-mock-task">
          <span className={`hx-mock-check ${t.done ? "is-done" : ""}`} />
          <span className={`hx-mock-tasklabel ${t.done ? "is-done" : ""}`}>
            {t.t}
          </span>
        </div>
      ))}
    </div>
  );
}

function AIScreen() {
  return (
    <div className="hx-mock-ai">
      <div className="hx-mock-ai-q">Summarize my unread mail</div>
      <div className="hx-mock-ai-a">
        You have 3 unread: a Q3 roadmap review due Friday, GitHub PR #482 merged
        to main, and a $4,820 Stripe payout on the way. Want me to draft
        replies?
      </div>
      <div className="hx-mock-ai-bar">
        <span className="hx-mock-ai-input">Ask anything…</span>
        <span className="hx-mock-ai-send" />
      </div>
    </div>
  );
}

function HomeScreen() {
  const meetings = [
    { time: "10:00", title: "Daily standup", meta: "5 ppl" },
    { time: "2:00", title: "Sprint planning", meta: "8 ppl" },
  ];
  const tasks = [
    { title: "Draft Q3 roadmap", meta: "In progress" },
    { title: "Review PR #482", meta: "Today" },
    { title: "Rotate API keys", meta: "To do" },
  ];
  const emails = [
    {
      from: "Emily Carter",
      subject: "Q3 roadmap — final review before Friday",
      time: "9:24",
    },
    { from: "GitHub", subject: "[fluxze] PR #482 merged into main", time: "8:10" },
    {
      from: "Marco Rossi",
      subject: "Re: Q3 invoice — approved, payment sent",
      time: "Yest",
    },
  ];
  return (
    <div className="hx-mock-home">
      <div className="hx-mock-home-row">
        <section className="hx-mock-block">
          <header className="hx-mock-block-head">
            <span className="hx-mock-block-title">Meetings</span>
            <span className="hx-mock-block-action">Open scheduler →</span>
          </header>
          <ul className="hx-mock-block-list">
            {meetings.map((m) => (
              <li key={m.title} className="hx-mock-block-row">
                <span className="hx-mock-row-dot" />
                <span className="hx-mock-row-time">{m.time}</span>
                <span className="hx-mock-row-title">{m.title}</span>
                <span className="hx-mock-row-meta">{m.meta}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="hx-mock-block">
          <header className="hx-mock-block-head">
            <span className="hx-mock-block-title">Task</span>
            <span className="hx-mock-block-action">+ Add task</span>
          </header>
          <ul className="hx-mock-block-list">
            {tasks.map((t) => (
              <li key={t.title} className="hx-mock-block-row">
                <span className="hx-mock-row-check" />
                <span className="hx-mock-row-title">{t.title}</span>
                <span className="hx-mock-row-meta">{t.meta}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="hx-mock-block">
        <header className="hx-mock-block-head">
          <span className="hx-mock-block-title">Emails</span>
          <span className="hx-mock-block-action">Open inbox →</span>
        </header>
        <ul className="hx-mock-block-list">
          {emails.map((e) => (
            <li key={e.subject} className="hx-mock-block-row">
              <span className="hx-mock-row-dot is-unread" />
              <span className="hx-mock-row-from">{e.from}</span>
              <span className="hx-mock-row-subject">{e.subject}</span>
              <span className="hx-mock-row-meta">{e.time}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const RepoFolderIcon = (
  <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15">
    <path d="M1.75 4c0-.69.56-1.25 1.25-1.25h3.4c.4 0 .77.18 1 .5l.7.93h4.9c.69 0 1.25.56 1.25 1.25v6.07c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4z" />
  </svg>
);
const RepoFileIcon = (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    width="14"
    height="14"
  >
    <path d="M9 1.75H4.5c-.69 0-1.25.56-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h7c.69 0 1.25-.56 1.25-1.25V5L9 1.75z" />
    <path d="M9 1.75V5h3.75" />
  </svg>
);

function MoreScreen() {
  const folders = [
    ".github",
    ".idea",
    ".vscode",
    "apprunner",
    "colossal_django",
    "colossal_flask",
    "colossal_main",
    "myproject",
    "postgres",
  ];
  const files = [
    { n: ".gitignore", s: "82 B" },
    { n: "apprunner.yaml", s: "282 B" },
    { n: "Makefile", s: "386 B", active: true },
    { n: "manage.py", s: "665 B" },
    { n: "README.md", s: "6.0 KB" },
    { n: "requirements.txt", s: "99 B" },
    { n: "resume.html", s: "6.5 KB" },
    { n: "server.py", s: "638 B" },
    { n: "startup.sh", s: "86 B" },
  ];
  const makefile = `# hello:
#   echo "Hello, World"

files := file1 file2
some_file: $(files)
    echo "Look at this variable: " $(files)
    touch some_file

file1:
    touch file1
file2:
    touch file2

clean:
    rm -f file1 file2 some_file

migrate:
    python3 ./colossal_main/manage.py migrate

makemigrations:
    python3 ./colossal_main/manage.py makemigrations

runserver:
    python3 ./colossal_main/manage.py runserver`;
  const nav = [
    {
      label: "Description",
      icon: (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          width="15"
          height="15"
        >
          <path d="M8 4.4C7 3.2 5.5 3 3.5 3.2v8.3C5.5 11.3 7 11.5 8 12.7" />
          <path d="M8 4.4C9 3.2 10.5 3 12.5 3.2v8.3C10.5 11.3 9 11.5 8 12.7" />
        </svg>
      ),
    },
    { label: "Files", icon: RepoFolderIcon, active: true },
    {
      label: "Workflows",
      badge: 3,
      icon: (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          width="15"
          height="15"
        >
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" />
        </svg>
      ),
    },
    {
      label: "Commits",
      badge: 8,
      icon: (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          width="15"
          height="15"
        >
          <circle cx="8" cy="8" r="2.6" />
          <path d="M8 1.6v3.8M8 10.6v3.8" />
        </svg>
      ),
    },
    {
      label: "Actions",
      badge: 0,
      icon: (
        <svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13">
          <path d="M5 3.5l7 4.5-7 4.5z" />
        </svg>
      ),
    },
  ];
  return (
    <div className="hx-mock-repo">
      <aside className="hx-mock-repo-rail">
        <div className="hx-mock-repo-label">Repository</div>
        <div className="hx-mock-repo-select">
          <span>mahesivaya/colossaltech</span>
          <span className="hx-mock-repo-caret">▾</span>
        </div>
        <div className="hx-mock-repo-add">+ Add</div>
        <div className="hx-mock-repo-label">Branch</div>
        <div className="hx-mock-repo-select">
          <span>main</span>
          <span className="hx-mock-repo-caret">▾</span>
        </div>
        <nav className="hx-mock-repo-nav">
          {nav.map((it) => (
            <div
              key={it.label}
              className={`hx-mock-repo-navitem ${it.active ? "is-active" : ""}`}
            >
              <span className="hx-mock-repo-navico">{it.icon}</span>
              <span className="hx-mock-repo-navlabel">{it.label}</span>
              {it.badge !== undefined && (
                <span className="hx-mock-repo-navbadge">{it.badge}</span>
              )}
            </div>
          ))}
        </nav>
      </aside>

      <div className="hx-mock-repo-files">
        <div className="hx-mock-repo-files-head">Files</div>
        <div className="hx-mock-repo-files-list">
          {folders.map((f) => (
            <div key={f} className="hx-mock-repo-file is-dir">
              <span className="hx-mock-repo-chev">›</span>
              <span className="hx-mock-repo-fico">{RepoFolderIcon}</span>
              <span className="hx-mock-repo-fn">{f}</span>
            </div>
          ))}
          {files.map((f) => (
            <div
              key={f.n}
              className={`hx-mock-repo-file is-file ${
                f.active ? "is-active" : ""
              }`}
            >
              <span className="hx-mock-repo-chev" />
              <span className="hx-mock-repo-fico">{RepoFileIcon}</span>
              <span className="hx-mock-repo-fn">{f.n}</span>
              <span className="hx-mock-repo-fsz">{f.s}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="hx-mock-repo-code">
        <div className="hx-mock-repo-code-head">Makefile</div>
        <pre className="hx-mock-repo-code-body">{makefile}</pre>
      </div>
    </div>
  );
}

const TABS = [
  { key: "Home", search: "Search Fluxze…", Screen: HomeScreen },
  { key: "Mail", search: "Search mail…", Screen: MailScreen },
  { key: "Chat", search: "Search chat…", Screen: ChatScreen },
  { key: "Meet", search: "Search meetings…", Screen: MeetScreen },
  { key: "Drive", search: "Search files…", Screen: DriveScreen },
  { key: "Notes", search: "Search notes…", Screen: NotesScreen },
  { key: "Tasks", search: "Search tasks…", Screen: TasksScreen },
  { key: "AI", search: "Ask Fluxze AI…", Screen: AIScreen },
  { key: "More", search: "Go to file…", Screen: MoreScreen },
] as const;

export default function HeroMock() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    // Respect reduced-motion: still switchable by click, but don't auto-cycle.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(
      () => setActive((i) => (i + 1) % TABS.length),
      2800
    );
    return () => window.clearInterval(id);
  }, [paused]);

  const tab = TABS[active];
  const Screen = tab.Screen;

  return (
    <div
      className="hx-mock"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="hx-mock-bar">
        <span className="hx-dot hx-dot-r" />
        <span className="hx-dot hx-dot-y" />
        <span className="hx-dot hx-dot-g" />
        <span className="hx-mock-url">app.fluxze.com</span>
      </div>
      <div className="hx-mock-body">
        <aside className="hx-mock-side">
          <div className="hx-mock-logo">Fluxze</div>
          {TABS.map((t, i) => (
            <button
              key={t.key}
              type="button"
              className={`hx-mock-nav ${i === active ? "is-active" : ""}`}
              onClick={() => setActive(i)}
              aria-label={`Show ${t.key}`}
            >
              <span className="hx-mock-navdot" />
              {t.key}
            </button>
          ))}
        </aside>
        <div className="hx-mock-main">
          <div className="hx-mock-toolbar">
            <span className="hx-mock-search">{tab.search}</span>
          </div>
          <div className="hx-mock-screen" key={active}>
            <Screen />
          </div>
        </div>
      </div>
    </div>
  );
}
