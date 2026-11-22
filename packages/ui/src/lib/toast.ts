import { useSyncExternalStore } from "react";

export type Toast = { id: number; message: string; tone: "info" | "error" };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function toast(message: string, tone: Toast["tone"] = "info"): void {
  const id = nextId++;
  toasts = [...toasts, { id, message, tone }].slice(-3);
  emit();
  setTimeout(() => dismiss(id), tone === "error" ? 6000 : 3500);
}

export function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
  );
}
