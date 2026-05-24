import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import "./developers.css";

// Self-hosted Redoc — frontend/public/redoc.standalone.js. Loaded lazily on
// mount so the marketing pages don't pay the ~890KB cost. Lives in public/
// (not the bundle) to keep it out of the source map round-trip and to dodge
// the CSP script-src 'self' constraint without adding a CDN allowance.
const REDOC_SCRIPT = "/redoc.standalone.js";

declare global {
  interface Window {
    Redoc?: {
      init: (
        specUrl: string,
        options: Record<string, unknown>,
        element: HTMLElement,
      ) => void;
    };
  }
}

type Tutorial = {
  id: string;
  title: string;
  goal: string;
  scopes: string[];
  steps: Array<{ caption: string; code: string }>;
};

const TUTORIALS: Tutorial[] = [
  {
    id: "send-email",
    title: "Send your first email",
    goal: "Send a message from a connected mailbox in two API calls.",
    scopes: ["email:read", "email:send"],
    steps: [
      {
        caption: "List connected mailboxes → grab the account_id you want to send from.",
        code: `curl https://rwayve.maheshg.me/api/accounts \\
  -H "X-API-KEY: $WAYVE_KEY"

# [ { "id": 42, "email": "you@gmail.com", "unread_count": 7, ... } ]`,
      },
      {
        caption: "POST to /api/emails with that account_id + recipient + body.",
        code: `curl https://rwayve.maheshg.me/api/emails \\
  -H "X-API-KEY: $WAYVE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "account_id": 42,
    "to": "alice@example.com",
    "subject": "Hello from Wayve",
    "body": "Sent programmatically via the API."
  }'`,
      },
    ],
  },
  {
    id: "create-task",
    title: "Create a task",
    goal: "Add a to-do that shows up in the user's Tasks page immediately.",
    scopes: ["tasks:write"],
    steps: [
      {
        caption: "Priority is 1 (lowest) to 5 (highest); status defaults to 'in_progress'.",
        code: `curl https://rwayve.maheshg.me/api/tasks \\
  -H "X-API-KEY: $WAYVE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Review Q3 invoices",
    "description": "Cross-reference with the Stripe export",
    "priority": 4
  }'

# { "id": 17, "name": "Review Q3 invoices", "priority": 4, "status": "in_progress" }`,
      },
    ],
  },
  {
    id: "schedule-meeting",
    title: "Schedule a meeting",
    goal: "Book a meeting and (optionally) attach a Zoom link.",
    scopes: ["scheduler:write"],
    steps: [
      {
        caption: "Times are ISO 8601 UTC. Participants get an invite email.",
        code: `curl https://rwayve.maheshg.me/api/scheduler/meetings \\
  -H "X-API-KEY: $WAYVE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Sprint planning",
    "starts_at": "2026-06-03T15:00:00Z",
    "ends_at":   "2026-06-03T16:00:00Z",
    "participants": ["alice@acme.com", "bob@acme.com"],
    "create_zoom": true
  }'`,
      },
    ],
  },
  {
    id: "subscribe-webhook",
    title: "Subscribe to webhooks",
    goal: "Receive signed events when tasks or meetings change.",
    scopes: ["account login"],
    steps: [
      {
        caption: "POST /api/webhooks with your endpoint and the events you care about. The response carries the signing secret exactly once.",
        code: `curl https://rwayve.maheshg.me/api/webhooks \\
  -H "Authorization: Bearer $WAYVE_JWT" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://example.com/wayve/webhook",
    "events": ["task.created", "meeting.created"],
    "description": "CRM sync"
  }'

# { "id": 1, "secret": "whsec_...", "events": [...], ... }`,
      },
      {
        caption: "Verify each delivery by recomputing the HMAC. Pseudocode:",
        code: `// Node / Express receiver
import crypto from "node:crypto";

app.post("/wayve/webhook", express.raw({ type: "*/*" }), (req, res) => {
  const sig = req.header("Wayve-Signature") || "";
  const [tPart, vPart] = sig.split(",");
  const timestamp = tPart.split("=")[1];
  const provided  = vPart.split("=")[1];

  const expected = crypto
    .createHmac("sha256", process.env.WAYVE_WEBHOOK_SECRET)
    .update(\`\${timestamp}.\${req.body.toString()}\`)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return res.status(400).send("bad signature");
  }
  const event = JSON.parse(req.body.toString());
  // handle event.type / event.data ...
  res.sendStatus(200);
});`,
      },
    ],
  },
  {
    id: "ai-chat",
    title: "Run an AI prompt",
    goal: "Send a prompt to the assistant and continue the conversation.",
    scopes: ["ai:use"],
    steps: [
      {
        caption: "First call returns a conversation_id you can pass back to keep context.",
        code: `curl https://rwayve.maheshg.me/api/aichat \\
  -H "X-API-KEY: $WAYVE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "prompt": "Summarise yesterday'\\''s unread emails." }'

# { "reply": "...", "conversation_id": "8f3c..." }

curl https://rwayve.maheshg.me/api/aichat \\
  -H "X-API-KEY: $WAYVE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "prompt": "Now draft replies for the top three.",
        "conversation_id": "8f3c..." }'`,
      },
    ],
  },
];

const SCOPES = [
  { scope: "profile:read", group: "Read", desc: "Identity, plan, entitlements." },
  { scope: "email:read", group: "Read", desc: "List accounts and read messages." },
  { scope: "chat:read", group: "Read", desc: "Read channels and direct messages." },
  { scope: "scheduler:read", group: "Read", desc: "Meetings & calendar." },
  { scope: "drive:read", group: "Read", desc: "List & download files." },
  { scope: "notes:read", group: "Read", desc: "Read notes." },
  { scope: "tasks:read", group: "Read", desc: "Read tasks." },
  { scope: "email:send", group: "Write", desc: "Send mail, mutate message state." },
  { scope: "chat:write", group: "Write", desc: "Send messages, create channels." },
  { scope: "scheduler:write", group: "Write", desc: "Create / update / cancel meetings." },
  { scope: "drive:write", group: "Write", desc: "Upload, share, delete files." },
  { scope: "notes:write", group: "Write", desc: "Create / update / delete notes." },
  { scope: "tasks:write", group: "Write", desc: "Create / update / delete tasks." },
  { scope: "ai:use", group: "Write", desc: "Send prompts to the assistant." },
  { scope: "call:access", group: "Realtime", desc: "Initiate or accept WebRTC calls." },
  { scope: "admin", group: "Privileged", desc: "Tenant administration. Internal keys only." },
  { scope: "*", group: "Privileged", desc: "Full access. Internal keys, owner-gated." },
];

const SPEC_URL = "/api/openapi.json";

export default function Developers() {
  const { user } = useAuth();
  const redocRef = useRef<HTMLDivElement>(null);
  const [redocReady, setRedocReady] = useState(false);
  const [redocError, setRedocError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const init = () => {
      if (cancelled || !redocRef.current) return;
      const redoc = window.Redoc;
      if (!redoc) return;
      try {
        redoc.init(
          SPEC_URL,
          {
            scrollYOffset: 16,
            hideDownloadButton: false,
            disableSearch: false,
            theme: {
              colors: { primary: { main: "#2563eb" } },
              typography: {
                fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
                code: { fontSize: "13px" },
              },
            },
          },
          redocRef.current,
        );
        setRedocReady(true);
      } catch (err) {
        setRedocError(err instanceof Error ? err.message : "Failed to render reference");
      }
    };

    if (window.Redoc) {
      init();
      return () => {
        cancelled = true;
      };
    }

    let script = document.querySelector<HTMLScriptElement>(
      `script[src="${REDOC_SCRIPT}"]`,
    );
    if (!script) {
      script = document.createElement("script");
      script.src = REDOC_SCRIPT;
      script.async = true;
      document.body.appendChild(script);
    }
    const onLoad = () => init();
    const onError = () => {
      if (cancelled) return;
      setRedocError("Could not load the API reference bundle.");
    };
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    return () => {
      cancelled = true;
      script?.removeEventListener("load", onLoad);
      script?.removeEventListener("error", onError);
    };
  }, []);

  const dashboardLink = user ? "/platform/secrets" : "/register";

  return (
    <div className="dev-portal">
      <header className="dev-header">
        <Link to="/" className="dev-header-brand">
          <span className="dev-header-logo">✉</span>
          <span>Wayve</span>
        </Link>
        <nav className="dev-header-nav" aria-label="Developers navigation">
          <Link to="/">Home</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/enterprise">Enterprise</Link>
          <Link to="/support">Support</Link>
          <Link to="/developers" aria-current="page">Developers</Link>
        </nav>
        <div className="dev-header-actions">
          <Link to="/login">Sign in</Link>
          <Link to={dashboardLink} className="dev-header-primary">
            {user ? "API keys" : "Get started"}
          </Link>
        </div>
      </header>

      <header className="dev-hero">
        <div className="dev-hero-inner">
          <h1>Wayve Developers</h1>
          <p>
            Build on Wayve's email, chat, scheduling, drive, notes, tasks and AI
            primitives with a scoped, audited API. Every request is authenticated
            with an <code>X-API-KEY</code>; scopes, expiry, rate limits, and an
            append-only audit log keep tokens accountable.
          </p>
          <div className="dev-hero-cta">
            <Link to={dashboardLink} className="dev-btn primary">
              {user ? "Mint a key" : "Get an account →"}
            </Link>
            <a href={SPEC_URL} className="dev-btn" download="wayve-openapi.json">
              Download OpenAPI 3.1 spec
            </a>
            <Link to="/developers/quotas" className="dev-btn">
              Compare rate-limit tiers →
            </Link>
          </div>
        </div>
      </header>

      <section className="dev-section">
        <h2>Quick start</h2>
        <ol className="dev-steps">
          <li>
            <strong>Register or sign in</strong> at{" "}
            <Link to="/register">/register</Link>.
          </li>
          <li>
            <strong>Mint an API key</strong> from the dashboard with the narrowest
            scope set that satisfies your integration; set an expiry; copy the raw
            value — it is shown exactly once.
          </li>
          <li>
            <strong>Verify it works</strong> by hitting <code>/api/me</code>:
          </li>
        </ol>
        <pre className="dev-code">
{`curl https://rwayve.maheshg.me/api/me -H "X-API-KEY: wv_sk_..."
# 200 → identity        401 → bad key
# 403 → wrong scope     429 → rate-limited (retry with backoff)`}
        </pre>
      </section>

      <section id="tutorials" className="dev-section">
        <h2>Tutorials</h2>
        <p className="dev-muted">
          End-to-end worked examples. Each block is copy-pasteable — set{" "}
          <code>$WAYVE_KEY</code> in your shell first.
        </p>
        <div className="dev-tutorial-list">
          {TUTORIALS.map((tut) => (
            <article key={tut.id} className="dev-tutorial">
              <header className="dev-tutorial-head">
                <h3 id={tut.id}>{tut.title}</h3>
                <div className="dev-tutorial-meta">
                  {tut.scopes.map((scope) => (
                    <code key={scope}>{scope}</code>
                  ))}
                </div>
              </header>
              <p className="dev-tutorial-goal">{tut.goal}</p>
              {tut.steps.map((step, idx) => (
                <div key={idx} className="dev-tutorial-step">
                  <span className="dev-tutorial-stepnum">{idx + 1}</span>
                  <div>
                    <p>{step.caption}</p>
                    <pre className="dev-code">{step.code}</pre>
                  </div>
                </div>
              ))}
            </article>
          ))}
        </div>
      </section>

      <section className="dev-section">
        <h2>Scopes</h2>
        <p className="dev-muted">
          Scopes are stamped on a key at creation time and checked on every
          request against an internal route → scope map. A request to a route
          your key does not cover returns <code>403</code>, never falls back to
          a wider permission.
        </p>
        <div className="dev-scope-grid">
          {SCOPES.map((s) => (
            <div className={`dev-scope dev-scope-${s.group.toLowerCase()}`} key={s.scope}>
              <code>{s.scope}</code>
              <span className="dev-scope-group">{s.group}</span>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="dev-section">
        <h2>API reference</h2>
        <p className="dev-muted">
          The full machine-readable spec is at{" "}
          <a href={SPEC_URL}>
            <code>{SPEC_URL}</code>
          </a>{" "}
          — import it into Postman, Insomnia, an SDK generator, or any other
          OpenAPI 3.1-aware tool.
        </p>
        {redocError && <div className="dev-banner">{redocError}</div>}
        {!redocReady && !redocError && (
          <div className="dev-loader">Loading API reference…</div>
        )}
        <div
          ref={redocRef}
          className="dev-redoc"
          style={{ display: redocReady ? "block" : "none" }}
        />
      </section>

      <footer className="dev-footer">
        <div className="dev-footer-grid">
          <div className="dev-footer-brand">
            <Link to="/">
              <span className="dev-header-logo">✉</span>
              <span>Wayve</span>
            </Link>
            <p>Secure workspace APIs for mail, chat, scheduling, files, notes, tasks, and AI.</p>
          </div>

          <nav className="dev-footer-column" aria-label="Developer resources">
            <h2>Developers</h2>
            <Link to="/developers#tutorials">Tutorials</Link>
            <a href={SPEC_URL}>OpenAPI spec</a>
            <Link to={dashboardLink}>API keys</Link>
            <Link to="/support">Support</Link>
          </nav>

          <nav className="dev-footer-column" aria-label="Platform">
            <h2>Platform</h2>
            <Link to="/enterprise">Enterprise</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/services/email">Email</Link>
            <Link to="/services/scheduler">Scheduler</Link>
          </nav>

          <nav className="dev-footer-column" aria-label="Company">
            <h2>Company</h2>
            <Link to="/about">About</Link>
            <Link to="/support">Contact</Link>
            <Link to="/security/audit">Transparency Report</Link>
            <Link to="/enterprise">Technical white paper</Link>
          </nav>

          <div className="dev-footer-social" aria-label="Follow us">
            <h2>Follow us</h2>
            <div className="dev-social-links">
              <a href="https://www.linkedin.com" aria-label="LinkedIn">in</a>
              <a href="https://x.com" aria-label="X">x</a>
              <a href="https://www.youtube.com" aria-label="YouTube">▶</a>
              <a href="https://github.com" aria-label="GitHub">gh</a>
            </div>
          </div>
        </div>

        <div className="dev-footer-bottom">
          <p>© Wayve B.V. {new Date().getFullYear()}</p>
          <p>
            Need higher rate limits, dedicated tenancy, or a custom SLA?{" "}
            <Link to="/enterprise">Talk to sales →</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
