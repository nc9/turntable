import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getBackend } from "@/api";
import type { GrepResult } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { formatBytes } from "@/lib/format";
import { sanitize } from "@/log/parser";
import { cn } from "@/lib/utils";

const MAX_MATCHES = 200;

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: GrepResult };

/**
 * Server-side search of the whole log, for text past the window the viewer has loaded. Hits
 * come back as byte offsets plus line text (untrusted, so sanitised and rendered as text).
 * Picking a hit asks the viewer to scroll there, loading more of the log if needed.
 */
export function LogGrepPanel({
  attemptId,
  query,
  loadedBytes,
  onJump,
  onClose,
}: {
  attemptId: string;
  query: string;
  /** Bytes already in the viewer; hits below this offset are one click away. */
  loadedBytes: number;
  onJump: (offset: number) => void;
  onClose: () => void;
}) {
  const [regex, setRegex] = useState(false);
  const [from, setFrom] = useState<number | undefined>(undefined);
  const [state, setState] = useState<State>({ kind: "loading" });

  // A new query or mode restarts the scan from the top.
  useEffect(() => setFrom(undefined), [query, regex, attemptId]);

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    // Debounce typing: the scan runs on the server.
    const t = setTimeout(() => {
      getBackend()
        .api.grepLog({
          attemptId,
          pattern: query,
          regex,
          ignoreCase: true,
          context: 0,
          maxMatches: MAX_MATCHES,
          ...(from !== undefined ? { fromOffset: from } : {}),
        })
        .then(
          (result) => live && setState({ kind: "done", result }),
          (e: unknown) =>
            live &&
            setState({
              kind: "error",
              message: e instanceof Error ? e.message : "The search failed",
            }),
        );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [attemptId, query, regex, from]);

  return (
    <div className="border-b border-line bg-surface" role="region" aria-label="Whole-log search">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-dim">
        <span className="min-w-0 flex-1 truncate" aria-live="polite">
          {state.kind === "loading" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3.5 spin" aria-hidden="true" />
              Searching the whole log
            </span>
          ) : state.kind === "error" ? (
            <span className="text-st-failure">{state.message}</span>
          ) : state.result.matches === 0 ? (
            `No matches in ${formatBytes(state.result.totalBytes)}`
          ) : (
            `${state.result.matches}${state.result.matches >= MAX_MATCHES ? "+" : ""} ${state.result.matches === 1 ? "match" : "matches"} in ${formatBytes(state.result.totalBytes)}`
          )}
        </span>
        <Toggle pressed={regex} onPressedChange={setRegex}>
          Regex
        </Toggle>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close whole-log search"
        >
          <X />
        </Button>
      </div>
      {state.kind === "done" && state.result.hits.length > 0 ? (
        <ul className="max-h-56 overflow-auto border-t border-line font-mono text-xs">
          {state.result.hits.map((h) => (
            <li key={h.offset}>
              <button
                type="button"
                onClick={() => onJump(h.offset)}
                className={cn(
                  "flex w-full items-baseline gap-3 px-3 py-1 text-left hover:bg-muted focus-visible:-outline-offset-2",
                  h.context && "text-dim",
                )}
              >
                <span className="tabular w-20 shrink-0 text-right text-faint">
                  {formatBytes(h.offset)}
                  {h.offset >= loadedBytes ? " +" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate">{sanitize(h.text)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {state.kind === "done" && state.result.nextOffset !== null ? (
        <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs text-dim">
          Scanned to {formatBytes(state.result.nextOffset)} of{" "}
          {formatBytes(state.result.totalBytes)}.
          <Button
            variant="secondary"
            size="xs"
            onClick={() => setFrom(state.result.nextOffset ?? undefined)}
          >
            Continue searching
          </Button>
        </div>
      ) : null}
    </div>
  );
}
