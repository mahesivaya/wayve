import SettingsShell from "../profile/SettingsShell";
import { isDesktopApp } from "../utils/desktop";
import "./shortcuts.css";

// Every keyboard shortcut in the app, in one place. Keep this list in step
// with the handlers it describes (TabBar, Layout's split keys, EmailDetail's
// useShortcuts map, the chat composers, and the desktop menu in
// desktop/main.cjs).

/** A key in a combo. "mod" is Cmd on a Mac and Ctrl elsewhere; "ctrl" is
 *  Control on every platform. */
type Key = string;

type Shortcut = { keys: Key[]; action: string; note?: string };
type Group = {
  title: string;
  hint?: string;
  items: Shortcut[];
  desktopOnly?: boolean;
};

const GROUPS: Group[] = [
  {
    title: "Tabs",
    items: [
      {
        keys: ["mod", "←"],
        action: "Previous tab",
        note: "Stops at the first tab",
      },
      { keys: ["mod", "→"], action: "Next tab", note: "Stops at the last tab" },
      { keys: ["ctrl", "Tab"], action: "Next tab, looping round" },
      { keys: ["ctrl", "shift", "Tab"], action: "Previous tab, looping round" },
      { keys: ["mod", "alt", "T"], action: "New tab" },
      { keys: ["mod", "alt", "W"], action: "Close tab" },
    ],
  },
  {
    title: "Split view",
    hint: "On wider windows.",
    items: [
      { keys: ["mod", "\\"], action: "Split right" },
      { keys: ["mod", "/"], action: "Split left" },
      {
        keys: ["mod", "shift", "\\"],
        action: "Split the focused pane top and bottom",
      },
    ],
  },
  {
    title: "Email",
    hint: "While reading an email.",
    items: [
      { keys: ["R"], action: "Reply" },
      { keys: ["A"], action: "Reply all" },
      { keys: ["F"], action: "Forward" },
      { keys: ["D"], action: "Delete" },
      { keys: ["Esc"], action: "Cancel the reply or forward" },
    ],
  },
  {
    title: "Writing messages",
    items: [
      { keys: ["Enter"], action: "Send a chat or AI chat message" },
      { keys: ["shift", "Enter"], action: "New line in a chat message" },
      { keys: ["mod", "Enter"], action: "Post a pull request comment" },
    ],
  },
  {
    title: "Desktop app",
    desktopOnly: true,
    items: [
      { keys: ["mod", "["], action: "Back" },
      { keys: ["mod", "]"], action: "Forward" },
      { keys: ["mod", "shift", "H"], action: "Return to Fluxze" },
      { keys: ["mod", "R"], action: "Reload" },
      { keys: ["mod", "+"], action: "Zoom in" },
      { keys: ["mod", "-"], action: "Zoom out" },
      { keys: ["mod", "0"], action: "Actual size" },
      { keys: ["mod", "U"], action: "Check for updates" },
    ],
  },
];

function isMac(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  );
}

function label(key: Key, mac: boolean): string {
  switch (key) {
    case "mod":
      return mac ? "⌘" : "Ctrl";
    case "ctrl":
      return mac ? "⌃" : "Ctrl";
    case "alt":
      return mac ? "⌥" : "Alt";
    case "shift":
      return mac ? "⇧" : "Shift";
    default:
      return key;
  }
}

export default function Shortcuts() {
  const mac = isMac();
  const desktop = isDesktopApp();
  const groups = GROUPS.filter((g) => !g.desktopOnly || desktop);

  return (
    <SettingsShell title="Shortcuts">
      {groups.map((group) => (
        <section className="settings-card shortcuts-card" key={group.title}>
          <h2 className="settings-card-title">{group.title}</h2>
          {group.hint && <p className="shortcuts-hint">{group.hint}</p>}
          <dl className="shortcuts-list">
            {group.items.map((item) => (
              <div className="shortcuts-row" key={item.action}>
                <dt>
                  {item.action}
                  {item.note && (
                    <span className="shortcuts-note">{item.note}</span>
                  )}
                </dt>
                <dd aria-label={item.keys.map((k) => label(k, mac)).join(" ")}>
                  {item.keys.map((k) => (
                    <kbd key={k}>{label(k, mac)}</kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="shortcuts-footnote">
        Single-letter shortcuts are off while you're typing in a text box.
      </p>
    </SettingsShell>
  );
}
