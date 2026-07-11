import { useEffect, useState } from "react";
import {
  connectSlack,
  disconnectSlack,
  getSlackConnection,
  importSlack,
  linkSlackChannel,
  listSlackChannels,
  type SlackChannel,
  type SlackConnectionStatus,
} from "../api/slack";
import "./slackPanel.css";

const EMPTY: SlackConnectionStatus = {
  connected: false,
  team_name: null,
  enabled: false,
};

// Enterprise-only Slack bridge: connect a workspace with a bot token, link Slack
// channels to Wayve channels, and import history. Inbound messages are stored
// server-readable (enterprise chat is not E2E) and render under Chat; new Wayve
// messages in a linked channel are posted back to Slack.
export default function SlackPanel() {
  const [status, setStatus] = useState<SlackConnectionStatus | null>(null);
  const [token, setToken] = useState("");
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSlackConnection()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof Error ? e.message : fallback);

  const connect = async () => {
    if (!token.trim()) return;
    setBusy("connect");
    setError(null);
    setMessage(null);
    try {
      const s = await connectSlack(token.trim());
      setStatus(s);
      setToken("");
      setMessage(`Connected to ${s.team_name ?? "Slack"}.`);
    } catch (e) {
      fail(e, "Could not connect Slack. Check the bot token.");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await disconnectSlack();
      setStatus(EMPTY);
      setChannels(null);
      setMessage("Disconnected.");
    } catch (e) {
      fail(e, "Could not disconnect.");
    } finally {
      setBusy(null);
    }
  };

  const loadChannels = async () => {
    setBusy("channels");
    setError(null);
    try {
      setChannels(await listSlackChannels());
    } catch (e) {
      fail(e, "Could not load Slack channels.");
    } finally {
      setBusy(null);
    }
  };

  const link = async (c: SlackChannel) => {
    setBusy(`link:${c.id}`);
    setError(null);
    setMessage(null);
    try {
      const r = await linkSlackChannel({
        slack_channel_id: c.id,
        slack_channel_name: c.name,
      });
      setMessage(
        r.already_linked
          ? `#${c.name} is already linked.`
          : `Linked #${c.name} to a new Wayve channel.`
      );
    } catch (e) {
      fail(e, "Could not link the channel.");
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy("import");
    setError(null);
    setMessage(null);
    try {
      const r = await importSlack();
      setMessage(
        `Imported ${r.imported} message${r.imported === 1 ? "" : "s"} across ${
          r.channels
        } channel${r.channels === 1 ? "" : "s"}.`
      );
    } catch (e) {
      fail(e, "Import failed.");
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected ?? false;

  return (
    <div className="slack-panel">
      <details className="slack-guide">
        <summary>📖 How to connect Slack — setup guide</summary>
        <ol className="slack-guide-list">
          <li>
            Create a Slack app at{" "}
            <a
              href="https://api.slack.com/apps"
              target="_blank"
              rel="noopener noreferrer"
            >
              api.slack.com/apps
            </a>{" "}
            and add the bot scopes <code>channels:read</code>,{" "}
            <code>channels:history</code>, <code>chat:write</code>,{" "}
            <code>chat:write.customize</code>, <code>users:read</code>.
          </li>
          <li>
            <strong>Reinstall to Workspace</strong> after adding scopes — they
            do not apply until you do.
          </li>
          <li>
            Copy the <strong>Bot User OAuth Token</strong> (<code>xoxb-…</code>
            ), paste it below, and <strong>Connect</strong>.
          </li>
          <li>
            <strong>Load channels</strong> → <strong>Link</strong> a channel
            (this creates a Wayve channel under Messages).
          </li>
          <li>
            In Slack, run <code>/invite @YourApp</code> in each linked channel —{" "}
            <strong>required</strong> for messages to flow either way (otherwise
            posts fail with <code>not_in_channel</code>).
          </li>
          <li>
            For real-time Slack → Wayve: turn on{" "}
            <strong>Event Subscriptions</strong> with URL{" "}
            <code>https://fluxze.com/webhooks/slack_events</code> and subscribe
            to <code>message.channels</code> (your admin sets the signing
            secret).
          </li>
        </ol>
        <p className="slack-muted">
          The two silent gotchas:{" "}
          <strong>reinstall after changing scopes</strong> and{" "}
          <strong>invite the bot to the channel</strong>.{" "}
          <a
            href="https://github.com/mahesivaya/wayve/blob/main/docs/slack-setup.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            Full guide ↗
          </a>
        </p>
      </details>

      {!status ? (
        <p className="slack-muted">Loading…</p>
      ) : !connected ? (
        <div className="slack-connect">
          <p className="slack-muted">
            Paste a Slack <strong>bot token</strong> (<code>xoxb-…</code>) with
            the <code>channels:history</code>, <code>channels:read</code>,{" "}
            <code>chat:write</code>, <code>chat:write.customize</code>, and{" "}
            <code>users:read</code> scopes.
          </p>
          <div className="slack-row">
            <input
              type="password"
              className="slack-input"
              placeholder="xoxb-…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              className="slack-btn slack-btn--primary"
              onClick={() => void connect()}
              disabled={busy === "connect" || !token.trim()}
            >
              {busy === "connect" ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      ) : (
        <div className="slack-connected">
          <div className="slack-row slack-row--between">
            <span>
              Connected to <strong>{status.team_name ?? "Slack"}</strong>
            </span>
            <div className="slack-row">
              <button
                type="button"
                className="slack-btn"
                onClick={() => void loadChannels()}
                disabled={busy === "channels"}
              >
                {busy === "channels" ? "Loading…" : "Load channels"}
              </button>
              <button
                type="button"
                className="slack-btn slack-btn--primary"
                onClick={() => void runImport()}
                disabled={busy === "import"}
              >
                {busy === "import" ? "Importing…" : "Import linked"}
              </button>
              <button
                type="button"
                className="slack-btn slack-btn--danger"
                onClick={() => void disconnect()}
                disabled={busy === "disconnect"}
              >
                Disconnect
              </button>
            </div>
          </div>

          {channels && (
            <ul className="slack-channels">
              {channels.length === 0 && (
                <li className="slack-muted">No channels visible to the bot.</li>
              )}
              {channels.map((c) => (
                <li key={c.id} className="slack-channel">
                  <span>
                    {c.is_private ? "🔒" : "#"} {c.name}
                  </span>
                  <button
                    type="button"
                    className="slack-btn"
                    onClick={() => void link(c)}
                    disabled={busy === `link:${c.id}`}
                  >
                    {busy === `link:${c.id}` ? "Linking…" : "Link"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {message && <p className="slack-ok">{message}</p>}
      {error && <p className="slack-error">{error}</p>}
    </div>
  );
}
