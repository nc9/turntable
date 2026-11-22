// Runs before first paint (module scripts in head are deferred, but this is tiny and avoids a
// flash by setting the theme attribute synchronously from the stored preference).
try {
  const stored = localStorage.getItem("tt-theme");
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
} catch {
  // storage blocked; fall back to the system preference
}
