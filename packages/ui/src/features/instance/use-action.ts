import { useCallback, useState } from "react";

export type Action<A extends unknown[], R> = {
  run: (...a: A) => Promise<R | null>;
  busy: boolean;
  /** The server's refusal, verbatim. */
  error: string | null;
};

/** Runs one instance operation, keeping its busy flag and the server's refusal text. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>): Action<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...a: A): Promise<R | null> => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...a);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The change was not accepted.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    // The callers pass a fresh closure each render; the latest one is what a click should run.
    [fn],
  );
  return { run, busy, error };
}

/** What a limit field means: blank leaves it alone, `none` removes it, a number sets it. */
export function parseLimit(text: string): number | null | undefined | string {
  const t = text.trim();
  if (t === "") return undefined;
  if (t.toLowerCase() === "none") return null;
  // Anything else that is not a number goes as typed, so the server refuses it in its own words.
  return /^\d+$/.test(t) ? Number(t) : t;
}
