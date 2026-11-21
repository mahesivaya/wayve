// Fired after any project is added, linked to a repo, renamed or removed, so
// lists already on screen (Code & reviews, the sidebar's Projects) reload: the
// app keeps pages open in tabs, so they wouldn't otherwise see a repo imported
// from Settings. Its own module so tests that mock the workspace API keep it.
export const PROJECTS_CHANGED = "rwayve:projects-changed";

export const announceProjectsChanged = () =>
  window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED));
