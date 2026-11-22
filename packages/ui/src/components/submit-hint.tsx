import { Kbd } from "@/components/ui/kbd";

const isApple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Subtle shortcut hint for a dialog's primary action. Hidden on touch devices. */
export function SubmitHint() {
  return (
    <Kbd className="hidden border-transparent bg-transparent text-current opacity-70 [@media(hover:hover)_and_(pointer:fine)]:inline-flex">
      {isApple ? "⌘↵" : "Ctrl↵"}
    </Kbd>
  );
}

/** True for Cmd+Enter or Ctrl+Enter, outside IME composition. */
export function isSubmitKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  nativeEvent: KeyboardEvent;
}): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing;
}
