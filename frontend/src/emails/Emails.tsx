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
  getEmail,
  getGmailConnectUrl,
  getOutlookConnectUrl,
  updateAccountDisplayName,
  wakeEmailSync,
} from "../api/email";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import { useInSplitPane } from "../components/SplitPaneContext";
import { FolderChips } from "./FolderChips";
import SearchBar from "../search/SearchBar";
import { logger } from "../utils/logger";
import type { EmailItem } from "./types";

const ACCOUNT_NAME_STORAGE_KEY = "rwayve.emailAccountNames";
const EMAIL_LIST_WIDTH_STORAGE_KEY = "rwayve.emailList.width";
const HAS_ACCOUNTS_STORAGE_KEY = "rwayve.emailHasAccounts";

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

  // `accounts` starts empty on every refresh, so gating the toolbar on
  // `accounts.length` alone would flash it during the load window.
  const hasAccountsStorageKey = user?.id
    ? `${HAS_ACCOUNTS_STORAGE_KEY}.${user.id}`
    : HAS_ACCOUNTS_STORAGE_KEY;
  const [hadAccountsHint] = useState(
    () => localStorage.getItem(hasAccountsStorageKey) === "1"
  );
  useEffect(() => {
    if (accountsLoaded) {
      localStorage.setItem(
        hasAccountsStorageKey,
        accounts.length > 0 ? "1" : "0"
      );
    }
  }, [accountsLoaded, accounts.length, hasAccountsStorageKey]);

  const showToolbar =
    accounts.length > 0 || (!accountsLoaded && hadAccountsHint);

  // Lifted out of the sidebar so both the sidebar "+" button and the email list's
  // empty-state CTA open the same modal.
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  // The open email is mirrored in the URL as `?open=<id>` so a refresh or deep
  // link restores it. This effect applies the param; the next one syncs back.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkAppliedRef = useRef<number | null>(null);
  useEffect(() => {
    const raw = searchParams.get("open");
    if (!raw) {
      // Reset the guard so navigating to the same id again works.
      deepLinkAppliedRef.current = null;
      return;
    }
    const id = Number(raw);
    if (!Number.isFinite(id)) {
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
    // The sync effect below just wrote this after a row click; don't disturb the
    // current layout.
    if (selectedEmail?.id === id) {
      deepLinkAppliedRef.current = id;
      return;
    }
    if (deepLinkAppliedRef.current === id) return;
    deepLinkAppliedRef.current = id;

    // Deep-linking an email that isn't already open forces list view, so it reads
    // as a full-width row rather than the right pane of the 3-column split.
    if (emailViewLayout !== "list") {
      setEmailViewLayout("list");
    }

    const fromList = emails.find((email) => email.id === id);
    if (fromList) {
      void openEmail(fromList);
      return;
    }

    // Not in the current page — fetch the row directly. A partial row is fine; the
    // detail pane fetches the body itself.
    let cancelled = false;
    void (async () => {
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
    // Re-runs when the loaded list changes, so an email arriving via a later page
    // or a background sync is picked up without re-navigating.
  }, [
    searchParams,
    emails,
    openEmail,
    setSearchParams,
    selectedEmail,
    emailViewLayout,
    setEmailViewLayout,
  ]);

  // Mirror the open email back into the URL. On first mount it leaves the URL
  // alone so the effect above can still restore an incoming `?open=` param.
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

  // When narrow, the 3-pane layout collapses to list OR detail. The threshold is
  // container width, not viewport width, so a resized split pane also responds.
  const mainRef = useRef<HTMLDivElement>(null);
  const sidebarDraggingRef = useRef(false);
  const emailListDraggingRef = useRef(false);
  const [isNarrow, setIsNarrow] = useState(false);
  // "Split" comes in two flavors: the app-level split pane, and the emails
  // page's own list+detail split layout. In either, the list is too cramped
  // for its header chips, so the folder menu relocates to the page toolbar
  // next to Compose.
  const inSplitPane = useInSplitPane();
  const chipsInToolbar = inSplitPane || emailViewLayout === "split";
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

  // Return from /oauth/callback. `connected=true` refreshes the account list (the
  // sync worker imports the mail on a later tick). It can instead return
  // `?error=email_in_use`: the mailbox belongs to a different Wayve user.
  const [oauthError, setOauthError] = useState<string | null>(null);

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
    const OAUTH_ERRORS: Record<string, string> = {
      email_in_use:
        "This mailbox is already connected to another Fluxze account. " +
        "To use it here, sign in to that account and disconnect it first.",
      mailbox_must_match_login:
        "You can only connect the mailbox for the address you sign in to " +
        "Fluxze with. Pick that account on the provider's sign-in screen.",
      mailbox_check_failed:
        "Couldn't verify the mailbox against your account just now. Please try again.",
    };
    const oauthMessage = errorParam ? OAUTH_ERRORS[errorParam] : undefined;
    if (oauthMessage) {
      // Deferred out of the effect body to satisfy the set-state-in-effect lint.
      // It still runs before paint, so there is no flash.
      const h = window.setTimeout(() => setOauthError(oauthMessage), 0);
      window.history.replaceState({}, "", "/emails");
      return () => window.clearTimeout(h);
    }
  }, [fetchAccounts, setRefreshTick]);

  // Steady 60s poll so mail synced by the backend worker appears without a manual
  // reload. Paused while the tab is hidden so it doesn't burn network or OAuth
  // quota in the background.
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
        // Wake first so the next fetchAccounts pulls anything synced while the tab
        // was hidden.
        void wakeEmailSync();
        tick();
        start();
      }
    };

    if (!document.hidden) {
      // Sync now rather than waiting on the adaptive worker schedule, which backs
      // off to ~5min for quiet accounts.
      void wakeEmailSync();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [fetchAccounts, setRefreshTick]);

  const addAccount = async () => {
    const url = await getGmailConnectUrl();
    window.location.href = url;
  };

  const addOutlookAccount = async () => {
    const url = await getOutlookConnectUrl();
    window.location.href = url;
  };

  const addProvider = (provider: import("./providers").ProviderId) => {
    switch (provider) {
      case "gmail":
        void addAccount();
        return;
      case "outlook":
        void addOutlookAccount();
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
  const isPersonalScope = user?.scope
    ? user.scope === "personal"
    : user?.account_type === "personal";
  // Any signed-in user may connect and manage their OWN mailbox — the address
  // they logged in with — so the Accounts panel and add-account button show for
  // every scope. Shared/domain mailboxes are still managed in /settings/inboxes.
  const showAccountManagement = !!user;
  // Mirrors the backend gate `require_external_mailbox_actor`: any authenticated
  // account may connect its own mailbox, regardless of scope.
  const canConnectOwnMailbox = !!user;
  // With activeAccount = null the backend returns owned + shared-member + wayve
  // mail, so every scope defaults to the unified inbox but can still drill into a
  // single shared one.
  const showAccountFilter = displayedAccounts.length > 0;

  // If a selected account disappears (e.g. a shared inbox is revoked), fall back
  // to the unified view rather than jumping to some other mailbox.
  useEffect(() => {
    if (activeAccount === null) return;
    const stillVisible = displayedAccounts.some(
      (account) => account.id === activeAccount
    );
    if (!stillVisible) {
      setActiveAccount(null);
    }
  }, [activeAccount, displayedAccounts, setActiveAccount]);

  return (
    <div className="emails-root">
      {showToolbar && (
        <div className="emails-page-toolbar">
          {/* Personal accounts keep Compose in the email sidebar instead. */}
          {!isPersonalScope && (
            <button
              className="compose-btn compose-btn--toolbar"
              onClick={() => setComposeOpen(true)}
              title="Compose"
            >
              Compose
            </button>
          )}
          {/* Split (pane or list+detail layout): the folder menu sits next to
            Compose (the list header that normally hosts it is too cramped). */}
          {chipsInToolbar && !isPersonalScope && (
            <>
              <FolderChips
                activeFolder={viewMode === "email" ? activeFolder : null}
                onSelectFolder={(f) => {
                  setViewMode("email");
                  setSelectedEmail(null);
                  setActiveFolder(f);
                }}
              />
              <button
                type="button"
                className={`email-bulk-action${viewMode === "files" ? " is-active" : ""}`}
                onClick={openFiles}
                aria-pressed={viewMode === "files"}
                title="Show all attachments across your emails"
              >
                Attachments
              </button>
            </>
          )}
          <SearchBar />
        </div>
      )}
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
        {/* Org and platform pages just read the unified inbox, so the sidebar and
            its resizer are hidden and the list takes the full width. */}
        {isPersonalScope && showToolbar && (
          <>
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
              showComposeButton={isPersonalScope && showToolbar}
              showFolderNav={isPersonalScope}
            />

            <div
              className="email-sidebar-resizer"
              onMouseDown={startSidebarResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize email sidebar"
              title="Drag to resize sidebar"
            />
          </>
        )}

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
            showChrome={showToolbar}
            canAddAccount={canConnectOwnMailbox}
            onAddAccount={() => setAddAccountOpen(true)}
            showFolderTabs={!isPersonalScope && !chipsInToolbar}
            onSelectFolder={(f) => {
              setViewMode("email");
              setActiveFolder(f);
            }}
            onShowAttachments={openFiles}
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

        {/* Mounted only while open, so its state is fresh each time and needs no
            reset-on-close. */}
        {canConnectOwnMailbox && addAccountOpen && (
          <ProviderPicker
            onClose={() => setAddAccountOpen(false)}
            onSelect={(provider) => {
              setAddAccountOpen(false);
              addProvider(provider);
            }}
            onConnected={() => {
              // IMAP connect succeeded with no redirect, so refresh here.
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
            onSelectFolder={
              // Same scope gate as the list's folder chips: personal accounts
              // navigate folders via the sidebar instead. When the chips sit
              // in the page toolbar (split), skip the duplicate here.
              !isPersonalScope && !chipsInToolbar
                ? (f) => {
                    setViewMode("email");
                    setSelectedEmail(null);
                    setActiveFolder(f);
                  }
                : undefined
            }
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
