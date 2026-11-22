import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem("tt-theme");
    if (v === "light" || v === "dark") return v;
  } catch {
    // storage unavailable
  }
  return "system";
}

function apply(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function useTheme(): {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  toggle: () => void;
} {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  useEffect(() => apply(pref), [pref]);
  const setPref = useCallback((p: ThemePref) => {
    try {
      if (p === "system") localStorage.removeItem("tt-theme");
      else localStorage.setItem("tt-theme", p);
    } catch {
      // storage unavailable; the choice still applies for this session
    }
    setPrefState(p);
  }, []);
  const toggle = useCallback(() => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    setPref(dark ? "light" : "dark");
  }, [setPref]);
  return { pref, setPref, toggle };
}
