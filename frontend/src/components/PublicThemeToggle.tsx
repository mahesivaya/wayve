import { usePublicTheme } from "../theme/usePublicTheme";

// Sun / moon button for the public pages' light and dark modes. The icon shows
// the mode a click switches to. `labelled` adds the text, for the mobile menu.
export default function PublicThemeToggle({
  labelled = false,
}: {
  labelled?: boolean;
}) {
  const { mode, toggle } = usePublicTheme();
  const next = mode === "dark" ? "light" : "dark";
  const label = next === "light" ? "Light mode" : "Dark mode";

  return (
    <button
      type="button"
      className={`public-theme-toggle${labelled ? " public-theme-toggle--labelled" : ""}`}
      onClick={toggle}
      aria-label={`Switch to ${label.toLowerCase()}`}
      title={`Switch to ${label.toLowerCase()}`}
    >
      <span className="public-theme-toggle-icon" aria-hidden="true">
        {next === "light" ? "☀" : "☾"}
      </span>
      {labelled && <span>{label}</span>}
    </button>
  );
}
