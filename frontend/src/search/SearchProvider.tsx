import React, { useState, useMemo } from "react";
import { SearchContext } from "./SearchContext";

interface SearchProviderProps {
  children: React.ReactNode;
}

export default function SearchProvider({ children }: SearchProviderProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [emailViewLayout, setEmailViewLayout] = useState<"list" | "split">(
    () => {
      const stored = localStorage.getItem("rwayve.emailViewLayout");
      // List view is the default; only an explicitly saved "split" preference
      // opts into the two-pane layout.
      return stored === "split" ? "split" : "list";
    }
  );

  React.useEffect(() => {
    localStorage.setItem("rwayve.emailViewLayout", emailViewLayout);
  }, [emailViewLayout]);

  const value = useMemo(() => {
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    return {
      searchQuery,
      normalizedSearchQuery,
      setSearchQuery,
      emailViewLayout,
      setEmailViewLayout,
    };
  }, [searchQuery, emailViewLayout]);

  return (
    <SearchContext.Provider value={value}>{children}</SearchContext.Provider>
  );
}
