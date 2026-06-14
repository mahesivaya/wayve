import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import "./emails.css";
import "./loadMore.css";
import "../files/emailFiles.css";
import SendEmail from "./SendEmail";
import Modal from "../components/Modal";
import { EmailSidebar } from "./EmailSidebar";
import { EmailList } from "./EmailList";
import { EmailDetail } from "./EmailDetail";
import ProviderPicker from "./ProviderPicker";
import { useEmailInbox } from "./useEmailInbox";
import {
  connectYahoo,
  getEmail,
  getGmailConnectUrl,
  getOutlookConnectUrl,
  updateAccountDisplayName,
  wakeEmailSync,
} from "../api/email";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import SearchBar from "../search/SearchBar";
import { logger } from "../utils/logger";
import type { EmailItem } from "./types";

const ACCOUNT_NAME_STORAGE_KEY = "rwayve.emailAccountNames";
const EMAIL_LIST_WIDTH_STORAGE_KEY = "rwayve.emailList.width";

export default function Emails() {
  const { user, logout } = useAuth();
  const { normalizedSearchQuery, emailViewLayout, setEmailViewLayout } =
    useGlobalSearch();

  const {
    accounts,
    accountsLoaded,
    emails,
    selectedEmail,
    setSelectedEmail,
    activeAccount,
    setActiveAccount,
    activeFolder,
    setActiveFolder,
    hasMore,
    loadingMore,
    viewMode,
    setViewMode,
    files,
    filesLoading,
    filesError,
    fetchAccounts,
    setRefreshTick,
    loadMore,
    openFiles,
    openEmail,
    deleteEmail,
    bulkMarkRead,
    bulkDelete,
  } = useEmailInbox(user?.id, normalizedSearchQuery);

  // The "add a mailbox" picker. Lifted here (rather than living inside the
  // sidebar) so both the sidebar "+" button and the empty-state CTA in the
  // email list open the same single modal.
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  // The open email is reflected in the URL as `?open=<id>` so that a page
  // refresh (or a deep-link from another surface, e.g. the home dashboard's
  // Inbox card) RESTORES it instead of dropping back to the list. This effect
  // applies the param → opens the email; the effect below keeps the param in
  // sync the other way (selectedEmail → URL). It first checks the already-
  // loaded list to avoid an extra round-trip, and on a miss fetches by id.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkAppliedRef = useRef<number | null>(null);
  useEffect(() => {
    const raw = searchParams.get("open");
    if (!raw) {
      // No param — reset the guard so navigating to the same id again works.
      deepLinkAppliedRef.current = null;
      return;
    }
    const id = Number(raw);
    if (!Number.isFinite(id)) {
      // Bad value — drop the param and bail.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("open");
          return next;
        },
        { replace: true }
      );
      return;
    }
    // The param already matches what's open (typically because the sync effect
    // below just wrote it after a row click) — nothing to do, and crucially
    // don't disturb the current layout.
    if (selectedEmail?.id === id) {
      deepLinkAppliedRef.current = id;
      return;
    }
    if (deepLinkAppliedRef.current === id) return;
    deepLinkAppliedRef.current = id;

    // Force the list-view layout when RESTORING/deep-linking an email that
    // isn't already open, so it reads as an expanded full-width row rather
    // than the right pane of the 3-column split. Matches the home dashboard's
    // "click a row → see that one email" expectation. The user can toggle back
    // to split via the SearchBar's layout buttons.
    if (emailViewLayout !== "list") {
      setEmailViewLayout("list");
    }

    const fromList = emails.find((email) => email.id === id);
    if (fromList) {
      void openEmail(fromList);
      return;
    }

    // Not in the current page — fetch the row directly. The detail pane is fine
    // with a partial row (body fetches on its own); openEmail does the rest.
    let cancelled = false;
    (async () => {
      try {
        const full = await getEmail<EmailItem>(id);
        if (cancelled) return;
        await openEmail(full);
      } catch (err) {
        logger.warn("deep-link email open failed", { id, err });
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-run when the loaded list changes — if the email arrives via a later
    // page or background sync, this effect picks it up without a re-navigate.
  }, [
    searchParams,
    emails,
    openEmail,
    setSearchParams,
    selectedEmail,
    emailViewLayout,
    setEmailViewLayout,
  ]);

  // Mirror the open email back into the URL (`?open=<id>`) so a refresh keeps
  // it open. Only reacts to genuine selection changes: on first mount, when
  // nothing has been selected yet, it leaves the URL alone so the effect above
  // can still restore from an incoming `?open=` param. Closing an email
  // (selectedEmail → null) removes the param.
  const prevSelectedIdRef = useRef<number | null>(null);
  useEffect(() => {
    const cur = selectedEmail?.id ?? null;
    if (cur === prevSelectedIdRef.current) return;
    const had = prevSelectedIdRef.current;
    prevSelectedIdRef.current = cur;
    if (cur !== null) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("open", String(cur));
          return next;
        },
        { replace: true }
      );
    } else if (had !== null) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("open");
          return next;
        },
        { replace: true }
      );
    }
  }, [selectedEmail?.id, setSearchParams]);

  const [composeOpen, setComposeOpen] = useState(false);
  const [accountNameOverrides, setAccountNameOverrides] = useState<
    Record<number, string>
  >(() => {
    try {
      const stored = localStorage.getItem(ACCOUNT_NAME_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as Record<number, string>) : {};
    } catch {
      return {};
    }
  });

  // ================= NARROW MODE (split-pane / small viewport) =================
  // When the container is narrow (e.g. rendered inside the split view), we
  // collapse the 3-pane layout to a stacked one: show the list OR the detail,
  // not both. The threshold is the container width — independent of viewport
  // size, so this also responds correctly to a resized split.
  const mainRef = useRef<HTMLDivElement>(null);
  const sidebarDraggingRef = useRef(false);
  const emailListDraggingRef = useRef(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = localStorage.getItem("rwayve.emailSidebar.width");
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) ? Math.min(360, Math.max(180, parsed)) : 220;
  });
  const [emailListWidth, setEmailListWidth] = useState<number>(() => {
    const stored = localStorage.getItem(EMAIL_LIST_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) ? Math.min(620, Math.max(220, parsed)) : 360;
  });

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const narrow = entry.contentRect.width < 800;
        setIsNarrow((prev) => (prev !== narrow ? narrow : prev));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    localStorage.setItem("rwayve.emailSidebar.width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(EMAIL_LIST_WIDTH_STORAGE_KEY, String(emailListWidth));
  }, [emailListWidth]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      if (sidebarDraggingRef.current) {
        const nextWidth = e.clientX - rect.left;
        setSidebarWidth(Math.min(360, Math.max(180, nextWidth)));
        return;
      }
      if (emailListDraggingRef.current) {
        const sidebarResizerWidth = 8;
        const minDetailWidth = 320;
        const available =
          rect.width - sidebarWidth - sidebarResizerWidth - minDetailWidth;
        const maxListWidth = Math.min(620, Math.max(220, available));
        const nextWidth =
          e.clientX - rect.left - sidebarWidth - sidebarResizerWidth;
        setEmailListWidth(Math.min(maxListWidth, Math.max(220, nextWidth)));
      }
    }

    function onUp() {
      if (!sidebarDraggingRef.current && !emailListDraggingRef.current) return;
      sidebarDraggingRef.current = false;
      emailListDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [sidebarWidth]);

  function startSidebarResize() {
    sidebarDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function startEmailListResize() {
    emailListDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const useSingleColumn = isNarrow;
  const showList =
    viewMode === "email" &&
    ((emailViewLayout === "list" && selectedEmail === null) ||
      (emailViewLayout === "split" &&
        (!useSingleColumn || selectedEmail === null)));
  const showDetail =
    viewMode === "files" ||
    (emailViewLayout === "list" && selectedEmail !== null) ||
    (emailViewLayout === "split" &&
      (!useSingleColumn || selectedEmail !== null));
  const showEmailListResizer =
    viewMode === "email" && showList && showDetail && !useSingleColumn;

  const composeAccountId =
    activeAccount ??
    accounts.find((account) => account?.id !== undefined)?.id ??
    null;

  // ================= HANDLE OAUTH RETURN =================
  // After /oauth/callback redirects back with #connected=true, refresh the
  // account list so the newly linked account shows up immediately. The 30s
  // sync worker will import its emails on the next tick.
  //
  // On the other side, the callback can redirect back with `?error=...`
  // when the connect was rejected — currently the only such error is
  // `email_in_use` (the requested Gmail/Outlook is already attached to a
  // different Wayve user; see `email::account::email_owned_by_other_user`).
  // We surface it as a dismissible banner above the layout.
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Yahoo connect modal — Yahoo doesn't expose an OAuth flow for third
  // parties, so we collect email + app password locally and POST to
  // /api/yahoo/connect, which verifies via IMAP LOGIN before storing.
  const [yahooModalOpen, setYahooModalOpen] = useState(false);
  const [yahooEmail, setYahooEmail] = useState("");
  const [yahooPassword, setYahooPassword] = useState("");
  const [yahooBusy, setYahooBusy] = useState(false);
  const [yahooError, setYahooError] = useState("");

  const submitYahoo = async () => {
    setYahooError("");
    setYahooBusy(true);
    try {
      await connectYahoo(yahooEmail.trim(), yahooPassword.trim());
      setYahooModalOpen(false);
      setYahooEmail("");
      setYahooPassword("");
      // Refresh the account list + nudge the email-list refresh tick so the
      // newly-imported messages from the initial sync show up without a
      // manual reload.
      void fetchAccounts();
      setRefreshTick((tick) => tick + 1);
    } catch (err) {
      setYahooError(
        err instanceof Error
          ? err.message
          : "Could not connect Yahoo account. Try again."
      );
    } finally {
      setYahooBusy(false);
    }
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    if (
      params.get("connected") === "true" ||
      hashParams.get("connected") === "true"
    ) {
      void fetchAccounts();
      setRefreshTick((tick) => tick + 1);
      window.history.replaceState({}, "", "/emails");

      let attempts = 0;
      const poll = window.setInterval(() => {
        attempts += 1;
        setRefreshTick((tick) => tick + 1);

        if (attempts >= 12) {
          window.clearInterval(poll);
        }
      }, 2000);

      return () => window.clearInterval(poll);
    }

    const errorParam = params.get("error") ?? hashParams.get("error");
    if (errorParam === "email_in_use") {
      // Defer the setState out of the effect body so React's
      // set-state-in-effect lint stays quiet — same pattern used in
      // Docs.tsx and Tasks.tsx. The microtask still runs before the
      // browser paints, so the user sees the banner without a flash.
      const h = window.setTimeout(() => {
        setOauthError(
          "This mailbox is already connected to another Fluxze account. " +
            "To use it here, sign in to that account and disconnect it first."
        );
      }, 0);
      window.history.replaceState({}, "", "/emails");
      return () => window.clearTimeout(h);
    }
  }, [fetchAccounts, setRefreshTick]);

  // ================= BACKGROUND REFRESH =================
  // Steady poll so newly-arrived mail (synced into the DB by the 30s backend
  // worker) actually appears in the UI without a manual reload. Cadence is
  // 60s — twice the worker interval, so new mail surfaces in ~30–90s. The
  // user's selection survives each tick (see [useEmailInbox.ts](./useEmailInbox.ts))
  // so the open email won't be clobbered.
  //
  // Pauses while the tab is hidden via the Page Visibility API — a
  // background tab shouldn't burn CPU, network, or OAuth quotas. We force
  // one immediate refresh on the visibility → visible transition so the
  // user sees up-to-date mail the moment they switch back.
  useEffect(() => {
    const POLL_MS = 60_000;
    let timer: number | null = null;

    const tick = () => {
      void fetchAccounts();
      setRefreshTick((t) => t + 1);
    };

    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(tick, POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Catch up immediately on focus return, then resume polling.
        // Wake first so the next fetchAccounts pulls anything new
        // synced in the background since the tab was last visible.
        void wakeEmailSync();
        tick();
        start();
      }
    };

    if (!document.hidden) {
      // Initial mount: ask the backend to sync the caller's mailboxes
      // immediately, bypassing the adaptive worker schedule. New mail
      // surfaces in ≤ ~2s instead of ≤ ~5min for quiet accounts.
      void wakeEmailSync();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [fetchAccounts, setRefreshTick]);

  // ================= ADD ACCOUNT =================
  const addAccount = async () => {
    const url = await getGmailConnectUrl();
    window.location.href = url;
  };

  const addOutlookAccount = async () => {
    const url = await getOutlookConnectUrl();
    window.location.href = url;
  };

  // Single dispatcher from [ProviderPicker](./ProviderPicker.tsx). Each arm
  // is an existing helper — Gmail and Outlook use OAuth redirects; Yahoo
  // uses an app-password form (no OAuth) so we open a local modal instead
  // of redirecting away.
  const addProvider = (provider: import("./providers").ProviderId) => {
    switch (provider) {
      case "gmail":
        void addAccount();
        return;
      case "outlook":
        void addOutlookAccount();
        return;
      case "yahoo":
        setYahooModalOpen(true);
        return;
    }
  };

  const renameAccount = async (
    accountId: number,
    displayName: string | null
  ) => {
    const nextOverrides = { ...accountNameOverrides };

    if (displayName) {
      nextOverrides[accountId] = displayName;
    } else {
      delete nextOverrides[accountId];
    }

    setAccountNameOverrides(nextOverrides);
    localStorage.setItem(
      ACCOUNT_NAME_STORAGE_KEY,
      JSON.stringify(nextOverrides)
    );

    try {
      await updateAccountDisplayName(accountId, displayName);
      await fetchAccounts();
    } catch (err) {
      logger.warn("Account name saved locally; backend update failed", err);
    }
  };

  const displayedAccounts = accounts.map((account) => ({
    ...account,
    display_name: accountNameOverrides[account.id] ?? account.display_name,
  }));
  // Personal accounts and organization owners can connect external Gmail /
  // Outlook mailboxes to their own user — the same per-user OAuth flow.
  // Backend (`gmail_login`, `outlook_connect_url`) has no account-type gate;
  // this is purely a UI choice. Non-owner org members stick to org-wide
  // shared inboxes (see /settings/inboxes), so we don't surface the
  // single-user connect picker for them.
  const isPersonalScope = user?.scope
    ? user.scope === "personal"
    : user?.account_type === "personal";
  // Only personal accounts *manage* their own connected mailboxes — the
  // "Accounts" header + "+ Add account" button stay personal-only. Business
  // (organization) and platform teams manage shared/domain mailboxes in
  // /settings/inboxes instead.
  const showAccountManagement = isPersonalScope;
  // But every scope gets the account *filter* (the "🌐 All Accounts" pill + the
  // per-account rows) whenever they have at least one mailbox. This gives org /
  // platform users the unified "all emails" inbox by default (activeAccount =
  // null → backend returns the union of owned + shared-member + wayve mail) while
  // still letting them drill into a single shared inbox.
  const showAccountFilter = displayedAccounts.length > 0;

  // If a previously-selected account disappears (e.g. a shared inbox is revoked),
  // fall back to the unified "all emails" view rather than jumping to some other
  // mailbox. The default activeAccount is already null (useEmailInbox), so org /
  // platform users start unified without any forced selection.
  useEffect(() => {
    if (activeAccount === null) return;
    const stillVisible = displayedAccounts.some(
      (account) => account.id === activeAccount
    );
    if (!stillVisible) {
      setActiveAccount(null);
    }
  }, [activeAccount, displayedAccounts, setActiveAccount]);

  // ================= UI =================
  return (
    <div className="emails-root">
      <div className="emails-page-toolbar">
        {/* Organization / platform pages put Compose at the far left of the
            toolbar and let the search bar fill the rest to the right. Personal
            accounts keep Compose in the email sidebar. */}
        {!isPersonalScope && (
          <button
            className="compose-btn compose-btn--toolbar"
            onClick={() => setComposeOpen(true)}
            disabled={accounts.length === 0}
            title={accounts.length === 0 ? "No inbox available" : "Compose"}
          >
            Compose
          </button>
        )}
        <SearchBar />
      </div>
      <div
        ref={mainRef}
        className={[
          "main",
          isNarrow ? "narrow" : "",
          emailViewLayout === "list" ? "email-list-view" : "email-split-view",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {oauthError && (
          <div className="oauth-error-banner" role="alert">
            <button
              type="button"
              className="oauth-error-dismiss"
              onClick={() => setOauthError(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
            <span className="oauth-error-message">{oauthError}</span>
            <div className="oauth-error-actions">
              <button
                type="button"
                className="oauth-error-action"
                onClick={logout}
              >
                Sign in to the other account
              </button>
              <span className="oauth-error-hint">
                You&apos;ll be signed out of this account.
              </span>
            </div>
          </div>
        )}
        <EmailSidebar
          accounts={displayedAccounts}
          activeAccount={activeAccount}
          setActiveAccount={setActiveAccount}
          activeFolder={activeFolder}
          setActiveFolder={(f) => {
            setViewMode("email");
            setActiveFolder(f);
          }}
          viewMode={viewMode}
          onOpenFiles={openFiles}
          onRequestAddAccount={() => setAddAccountOpen(true)}
          onCompose={() => setComposeOpen(true)}
          composeDisabled={accounts.length === 0}
          width={sidebarWidth}
          onRenameAccount={renameAccount}
          showAccountFilter={showAccountFilter}
          showAccountManagement={showAccountManagement}
          showComposeButton={isPersonalScope}
        />

        <div
          className="email-sidebar-resizer"
          onMouseDown={startSidebarResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize email sidebar"
          title="Drag to resize sidebar"
        />

        {showList && (
          <EmailList
            emails={emails}
            selectedEmailId={selectedEmail?.id ?? null}
            onOpenEmail={openEmail}
            hasMore={hasMore}
            loadMore={loadMore}
            loadingMore={loadingMore}
            onCompose={() => setComposeOpen(true)}
            width={showEmailListResizer ? emailListWidth : undefined}
            isListView={emailViewLayout === "list"}
            onBulkMarkRead={bulkMarkRead}
            onBulkDelete={bulkDelete}
            activeFolder={activeFolder}
            hasAccounts={accounts.length > 0}
            accountsLoaded={accountsLoaded}
            canAddAccount={showAccountManagement}
            onAddAccount={() => setAddAccountOpen(true)}
          />
        )}

        {showEmailListResizer && (
          <div
            className="email-list-resizer"
            onMouseDown={startEmailListResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize email list"
            title="Drag to resize email list"
          />
        )}

        {/* Mounted only while open — keeps the picker's state fresh each time
          and avoids reset-on-close juggling. Opened by both the sidebar "+"
          and the email-list empty-state CTA. */}
        {showAccountManagement && addAccountOpen && (
          <ProviderPicker
            onClose={() => setAddAccountOpen(false)}
            onSelect={(provider) => {
              setAddAccountOpen(false);
              addProvider(provider);
            }}
            onConnected={() => {
              // IMAP connect succeeded (no redirect). Close + refresh the list
              // and nudge the email list so the new mailbox + its mail appear.
              setAddAccountOpen(false);
              void fetchAccounts();
              setRefreshTick((tick) => tick + 1);
            }}
          />
        )}

        <Modal
          isOpen={composeOpen && composeAccountId !== null}
          onClose={() => setComposeOpen(false)}
          title="New Message"
        >
          {composeAccountId !== null && (
            <SendEmail
              accountId={composeAccountId}
              onClose={() => setComposeOpen(false)}
            />
          )}
        </Modal>

        <Modal
          isOpen={yahooModalOpen}
          onClose={() => {
            if (yahooBusy) return;
            setYahooModalOpen(false);
            setYahooError("");
          }}
          title="Connect Yahoo Mail"
        >
          <form
            className="yahoo-connect-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitYahoo();
            }}
          >
            <p className="yahoo-connect-hint">
              Yahoo requires an <strong>app password</strong> — generate one at{" "}
              <a
                href="https://login.yahoo.com/account/security"
                target="_blank"
                rel="noreferrer"
              >
                Yahoo Account Security
              </a>{" "}
              → App Passwords. Then paste both fields below.
            </p>

            <label className="yahoo-connect-label">
              <span>Yahoo email</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={yahooEmail}
                onChange={(event) => setYahooEmail(event.target.value)}
                placeholder="you@yahoo.com"
                autoFocus
              />
            </label>

            <label className="yahoo-connect-label">
              <span>App password</span>
              <input
                type="password"
                required
                minLength={8}
                value={yahooPassword}
                onChange={(event) => setYahooPassword(event.target.value)}
                placeholder="16 characters from Yahoo App Passwords"
              />
            </label>

            {yahooError && <p className="yahoo-connect-error">{yahooError}</p>}

            <div className="yahoo-connect-actions">
              <button
                type="submit"
                disabled={
                  yahooBusy ||
                  !yahooEmail.trim() ||
                  yahooPassword.trim().length < 8
                }
              >
                {yahooBusy ? "Connecting…" : "Connect"}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={yahooBusy}
                onClick={() => {
                  setYahooModalOpen(false);
                  setYahooError("");
                  setYahooPassword("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>

        {showDetail && (
          <EmailDetail
            selectedEmail={selectedEmail}
            viewMode={viewMode}
            onBack={() => {
              setViewMode("email");
              setSelectedEmail(null);
            }}
            onDeleteEmail={deleteEmail}
            files={files}
            filesLoading={filesLoading}
            filesError={filesError}
            normalizedSearchQuery={normalizedSearchQuery}
            inboxAccountCount={accounts.length}
            inboxEmailCount={emails.length}
            inboxUncheckedCount={
              emails.filter((email) => email.attachments_checked === false)
                .length
            }
          />
        )}
      </div>
    </div>
  );
}
