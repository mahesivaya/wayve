import { logger } from "./logger";

/**
 * Dev-only interaction logger. Wires global listeners for clicks, form
 * submissions, route changes, uncaught errors, and unhandled promise
 * rejections so you can see what the user did right before any bug.
 *
 * Call once from main.tsx. Idempotent — safe under React StrictMode's
 * double-mount in dev.
 */

let installed = false;

const click = logger.scope("ui.click");
const form = logger.scope("ui.form");
const nav = logger.scope("ui.nav");
const err = logger.scope("ui.error");
const vis = logger.scope("ui.visibility");
const ws = logger.scope("ws");

const describe = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls =
    el.classList.length > 0
      ? `.${Array.from(el.classList).slice(0, 2).join(".")}`
      : "";
  const role = el.getAttribute("role");
  const aria = el.getAttribute("aria-label");
  const text = (el.textContent || "").trim().slice(0, 40);
  const parts = [`${tag}${id}${cls}`];
  if (role) parts.push(`role=${role}`);
  if (aria) parts.push(`aria="${aria}"`);
  if (text) parts.push(`"${text}"`);
  return parts.join(" ");
};

const findInteractive = (start: EventTarget | null): Element | null => {
  let node: Element | null = start instanceof Element ? start : null;
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (
      tag === "button" ||
      tag === "a" ||
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      node.getAttribute("role") === "button" ||
      node.getAttribute("role") === "link"
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
};

export const installDevLog = (): void => {
  if (installed) return;
  if (!import.meta.env.DEV) return;
  installed = true;

  // Clicks — capture phase so we see them before React handlers.
  window.addEventListener(
    "click",
    (ev) => {
      const target = findInteractive(ev.target);
      if (!target) return;
      click.debug(describe(target));
    },
    { capture: true }
  );

  // Form submissions — log target form and any submitter button.
  window.addEventListener(
    "submit",
    (ev) => {
      const f = ev.target as HTMLFormElement | null;
      if (!f || f.tagName !== "FORM") return;
      const submitter = (ev as SubmitEvent).submitter;
      form.info(
        `submit ${describe(f)}${submitter ? ` via ${describe(submitter)}` : ""}`
      );
    },
    { capture: true }
  );

  // Route changes — patch history.pushState/replaceState so SPA navigations
  // surface alongside back/forward.
  const emitRoute = (kind: string) => {
    nav.info(`${kind} → ${location.pathname}${location.search}`);
  };

  const origPush = history.pushState;
  history.pushState = function (...args) {
    const ret = origPush.apply(this, args);
    emitRoute("push");
    return ret;
  };
  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    const ret = origReplace.apply(this, args);
    emitRoute("replace");
    return ret;
  };
  window.addEventListener("popstate", () => emitRoute("pop"));
  emitRoute("init");

  // Uncaught errors and unhandled rejections — these are usually the most
  // useful signals when something silently fails.
  window.addEventListener("error", (ev) => {
    err.error(ev.message, {
      file: ev.filename,
      line: ev.lineno,
      col: ev.colno,
      error: ev.error,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    err.error("unhandled rejection", ev.reason);
  });

  // Tab visibility — helps correlate "user left and came back" bugs.
  document.addEventListener("visibilitychange", () => {
    vis.debug(document.visibilityState);
  });

  // Wrap WebSocket so chat/call sockets log open/close/error/message without
  // touching every call site. Open and close at info, message at debug to
  // avoid drowning the console for chatty sockets.
  const OrigWS = window.WebSocket;
  if (OrigWS && !(OrigWS as unknown as { __wrapped?: boolean }).__wrapped) {
    const Wrapped = function (
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[]
    ) {
      const display = typeof url === "string" ? url : url.toString();
      ws.info(`open → ${display}`);
      const sock =
        protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);

      sock.addEventListener("open", () => ws.info(`opened ${display}`));
      sock.addEventListener("close", (ev) =>
        ws.info(`closed ${display}`, { code: ev.code, reason: ev.reason })
      );
      sock.addEventListener("error", (ev) => ws.warn(`error ${display}`, ev));
      sock.addEventListener("message", (ev) => {
        const data =
          typeof ev.data === "string" ? ev.data : `[${typeof ev.data}]`;
        ws.debug(
          `msg ${display}`,
          data.length > 200 ? data.slice(0, 200) + "…" : data
        );
      });

      return sock;
    } as unknown as typeof WebSocket;
    Wrapped.prototype = OrigWS.prototype;
    (Wrapped as unknown as { __wrapped: boolean }).__wrapped = true;
    Object.assign(Wrapped, OrigWS);
    window.WebSocket = Wrapped;
  }

  logger.scope("devlog").info("interaction logging installed");
};
