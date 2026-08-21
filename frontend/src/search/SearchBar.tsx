import { useLocation } from "react-router-dom";
import { useGlobalSearch } from "./SearchContext";
import { getSearchLabel, shouldHideSearch } from "./SearchConfig";
import { useInSplitPane } from "../components/SplitPaneContext";

export default function SearchBar() {
  const location = useLocation();
  // Inside a split pane Emails.tsx forces the list layout, so neither button
  // would do anything — the whole group goes rather than sitting there inert.
  const inSplitPane = useInSplitPane();
  const { searchQuery, setSearchQuery, emailViewLayout, setEmailViewLayout } =
    useGlobalSearch();

  if (shouldHideSearch(location.pathname)) {
    return null;
  }

  const searchLabel = getSearchLabel(location.pathname);

  return (
    <div className="global-search-row">
      {/* On the emails page the view-layout toggles sit BEFORE the search box,
          and the box is pushed to the far right (see .emails-page-toolbar). */}
      {location.pathname.startsWith("/emails") && !inSplitPane && (
        <div
          className="email-layout-actions"
          role="group"
          aria-label="View layout"
        >
          <button
            type="button"
            className={`email-layout-btn ${emailViewLayout === "list" ? "active" : ""}`}
            onClick={() => setEmailViewLayout("list")}
            data-tooltip="List view"
            aria-label="List view"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="4" width="14" height="16" rx="2" />
              <path d="M8 9h8" />
              <path d="M8 12h8" />
              <path d="M8 15h8" />
            </svg>
          </button>
          <button
            type="button"
            className={`email-layout-btn ${emailViewLayout === "split" ? "active" : ""}`}
            onClick={() => setEmailViewLayout("split")}
            data-tooltip="Split view"
            aria-label="Split view"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M10 5v14" />
              <path d="M6 10h2" />
              <path d="M6 13h2" />
              <path d="M6 16h2" />
            </svg>
          </button>
        </div>
      )}
      <div className="global-search-box">
        <span className="global-search-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={`Search ${searchLabel}`}
          aria-label={`Search ${searchLabel}`}
        />
        {searchQuery && (
          <button
            type="button"
            className="global-search-clear"
            onClick={() => setSearchQuery("")}
            data-tooltip="Clear search"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
