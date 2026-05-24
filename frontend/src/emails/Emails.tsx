import { useEffect, useRef, useState } from "react";
import "./emails.css";
import "./loadMore.css";
import "../files/emailFiles.css";
import SendEmail from "./SendEmail";
import Modal from "../components/Modal";
import { EmailSidebar } from "./EmailSidebar";
import { EmailList } from "./EmailList";
import { EmailDetail } from "./EmailDetail";
import { useEmailInbox } from "./useEmailInbox";
import { getGmailConnectUrl, getOutlookConnectUrl, updateAccountDisplayName } from "../api/email";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";

const ACCOUNT_NAME_STORAGE_KEY = "rwayve.emailAccountNames";
const EMAIL_LIST_WIDTH_STORAGE_KEY = "rwayve.emailList.width";

export default function Emails() {
  const { user } = useAuth();
  const { normalizedSearchQuery, emailViewLayout } = useGlobalSearch();
  
  const {
    accounts, emails, selectedEmail, setSelectedEmail, activeAccount, 
    setActiveAccount, activeFolder, setActiveFolder, hasMore, loadingMore,
    viewMode, setViewMode, files, filesLoading, filesError, 
    fetchAccounts, setRefreshTick, loadMore, openFiles, openEmail, deleteEmail,
    bulkMarkRead, bulkDelete
  } = useEmailInbox(user?.id, normalizedSearchQuery);

  const [composeOpen, setComposeOpen] = useState(false);
  const [accountNameOverrides, setAccountNameOverrides] = useState<Record<number, string>>(() => {
    try {
      const stored = localStorage.getItem(ACCOUNT_NAME_STORAGE_KEY);
      return stored ? JSON.parse(stored) as Record<number, string> : {};
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
        const available = rect.width - sidebarWidth - sidebarResizerWidth - minDetailWidth;
        const maxListWidth = Math.min(620, Math.max(220, available));
        const nextWidth = e.clientX - rect.left - sidebarWidth - sidebarResizerWidth;
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
    (
      (emailViewLayout === "list" && selectedEmail === null) ||
      (emailViewLayout === "split" && (!useSingleColumn || selectedEmail === null))
    );
  const showDetail =
    viewMode === "files" ||
    (emailViewLayout === "list" && selectedEmail !== null) ||
    (emailViewLayout === "split" && (!useSingleColumn || selectedEmail !== null));
  const showEmailListResizer =
    viewMode === "email" && showList && showDetail && !useSingleColumn;

  const composeAccountId =
    activeAccount ?? accounts.find((account) => account?.id !== undefined)?.id ?? null;

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
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    if (
      params.get("connected") === "true" ||
      hashParams.get("connected") === "true"
    ) {
      fetchAccounts();
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
      setOauthError(
        "That email is already connected to another Wayve account. " +
          "Disconnect it from that account first, or sign in there instead.",
      );
      window.history.replaceState({}, "", "/emails");
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
        tick();
        start();
      }
    };

    if (!document.hidden) start();
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
  // is an existing OAuth helper — no new flow. Yahoo is rendered as
  // "Coming soon" in the picker and is never selectable, so we don't dispatch
  // on it here either (the exhaustive switch ensures we'll notice when it
  // does ship).
  const addProvider = (provider: import("./providers").ProviderId) => {
    switch (provider) {
      case "gmail":
        void addAccount();
        return;
      case "outlook":
        void addOutlookAccount();
        return;
      case "yahoo":
        // Picker disables Yahoo; this branch only fires once we wire it up.
        return;
    }
  };

  const renameAccount = async (accountId: number, displayName: string | null) => {
    const nextOverrides = { ...accountNameOverrides };

    if (displayName) {
      nextOverrides[accountId] = displayName;
    } else {
      delete nextOverrides[accountId];
    }

    setAccountNameOverrides(nextOverrides);
    localStorage.setItem(ACCOUNT_NAME_STORAGE_KEY, JSON.stringify(nextOverrides));

    try {
      await updateAccountDisplayName(accountId, displayName);
      await fetchAccounts();
    } catch (err) {
      console.warn("Account name saved locally; backend update failed", err);
    }
  };

  const displayedAccounts = accounts.map((account) => ({
    ...account,
    display_name: accountNameOverrides[account.id] ?? account.display_name,
  }));

  // ================= UI =================
  return (
    <div
      ref={mainRef}
      className={[
        "main",
        isNarrow ? "narrow" : "",
        emailViewLayout === "list" ? "email-list-view" : "email-split-view",
      ].filter(Boolean).join(" ")}
    >
      {oauthError && (
        <div className="oauth-error-banner" role="alert">
          <span>{oauthError}</span>
          <button
            type="button"
            className="oauth-error-dismiss"
            onClick={() => setOauthError(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <EmailSidebar
        accounts={displayedAccounts}
        activeAccount={activeAccount}
        setActiveAccount={setActiveAccount}
        activeFolder={activeFolder}
        setActiveFolder={(f) => { setViewMode("email"); setActiveFolder(f); }}
        viewMode={viewMode}
        onOpenFiles={openFiles}
        onAddProvider={addProvider}
        onCompose={() => setComposeOpen(true)}
        composeDisabled={accounts.length === 0}
        width={sidebarWidth}
        onRenameAccount={renameAccount}
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
          onBack={() => { setViewMode("email"); setSelectedEmail(null); }}
          onDeleteEmail={deleteEmail}
          files={files}
          filesLoading={filesLoading}
          filesError={filesError}
          normalizedSearchQuery={normalizedSearchQuery}
        />
      )}
    </div>
  );
}
