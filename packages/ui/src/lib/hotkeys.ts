import { useEffect } from "react";

const isEditable = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
};

export const isApple = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = (): string => (isApple() ? "⌘" : "Ctrl");

/**
 * Single-key shortcuts that ignore typing in fields and modified keys. `g` followed by a key
 * works as a two-step sequence (go to). Handlers receive the key that completed the shortcut.
 */
export function useHotkeys(map: Record<string, () => void>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let pendingG = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (isEditable(e.target)) return;
      if (pendingG) {
        pendingG = false;
        clearTimeout(timer);
        const fn = map[`g ${e.key}`];
        if (fn) {
          e.preventDefault();
          fn();
        }
        return;
      }
      if (e.key === "g" && Object.keys(map).some((k) => k.startsWith("g "))) {
        pendingG = true;
        timer = setTimeout(() => (pendingG = false), 900);
        return;
      }
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [map, enabled]);
}
