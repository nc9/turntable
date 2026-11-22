import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

/** Shared ticking clock so every running duration updates from one timer. */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let current = Date.now();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      current = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return subscribe(() => setNow(current));
  }, [active]);
  return now;
}

/** Duration that ticks while `finishedAt` is null. */
export function Duration({
  startedAt,
  finishedAt,
  className,
}: {
  startedAt: number | null;
  finishedAt: number | null;
  className?: string;
}) {
  const live = startedAt !== null && finishedAt === null;
  const now = useNow(live);
  if (startedAt === null) return <span className={className}>-</span>;
  return (
    <span className={`tabular ${className ?? ""}`}>
      {formatDuration((finishedAt ?? now) - startedAt)}
    </span>
  );
}
