import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Link2,
  ListTree,
  Scissors,
  Search,
  WrapText,
  X,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JobState } from "@/api/types";
import { ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/format";
import { modKey } from "@/lib/hotkeys";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isCollapsed, visibleLines, type LogLine, type LogParser } from "@/log/parser";
import { findMatches, type Match } from "@/log/search";
import { LogRow } from "./log-row";
import { LogSidebar } from "./log-sidebar";
import { downloadRawLog, VIEW_CAP, useAttemptLog } from "./use-log";

const LINE_H = 20;

/** For each cut, the position in `rows` it precedes (rows.length when it follows every line). */
function computeCutPos(parser: LogParser, rows: Int32Array): number[] {
  return parser.cuts.map((c) => {
    const target = parser.firstLineAtOrAfter(c.atOffset);
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((rows[mid] as number) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  });
}

type Selection = { a: number; b: number } | null;

function parseHash(hash: string): Selection {
  const m = /^#L(\d+)(?:-L?(\d+))?$/.exec(hash);
  if (!m) return null;
  const a = Number(m[1]) - 1;
  const b = Number(m[2] ?? m[1]) - 1;
  return a >= 0 && b >= 0 ? { a: Math.min(a, b), b: Math.max(a, b) } : null;
}

const hashFor = (s: Selection): string =>
  s ? (s.a === s.b ? `#L${s.a + 1}` : `#L${s.a + 1}-L${s.b + 1}`) : "";

/** Incrementally maintained search matches: appended lines are scanned once. */
function useMatches(
  lines: readonly LogLine[],
  version: number,
  query: string,
): { matches: Match[]; byLine: Map<number, Match[]>; token: number } {
  const state = useRef({
    query: "",
    scanned: 0,
    list: [] as Match[],
    token: 0,
    byLine: new Map<number, Match[]>(),
  });
  return useMemo(() => {
    const s = state.current;
    if (s.query !== query || s.scanned > lines.length) {
      s.query = query;
      s.scanned = 0;
      s.list = [];
      s.byLine = new Map();
      s.token += 1;
    }
    if (query !== "" && s.scanned < lines.length) {
      const before = s.list.length;
      findMatches(lines, query, s.scanned, s.list);
      for (let i = before; i < s.list.length; i++) {
        const m = s.list[i] as Match;
        const arr = s.byLine.get(m.line);
        if (arr) arr.push(m);
        else s.byLine.set(m.line, [m]);
      }
      s.scanned = lines.length;
      if (s.list.length !== before) s.token += 1;
    }
    return { matches: s.list, byLine: s.byLine, token: s.token };
    // `version` signals appended lines
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, version, query]);
}

export function LogViewer({
  attemptId,
  attemptState,
  filename,
  className,
}: {
  attemptId: string | null;
  attemptState: JobState;
  filename: string;
  className?: string;
}) {
  const active = attemptState === "running" || attemptState === "queued";
  const log = useAttemptLog(attemptId, active);
  const { parser, version } = log;

  const [follow, setFollow] = useState(active);
  const [wrap, setWrap] = useState(false);
  const [showTime, setShowTime] = useState(false);
  const [overrides, setOverrides] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [selection, setSelection] = useState<Selection>(() =>
    typeof window === "undefined" ? null : parseHash(window.location.hash),
  );
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [matchIdx, setMatchIdx] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const anchor = useRef<number | null>(selection?.a ?? null);
  const lastProgrammatic = useRef(0);
  const didInitialScroll = useRef(false);

  useEffect(() => {
    setFollow(active);
    didInitialScroll.current = false;
  }, [attemptId]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => visibleLines(parser, overrides), [parser, version, overrides]); // eslint-disable-line react-hooks/exhaustive-deps
  // Output-cap cuts are metadata, not log lines: each becomes a row of its own, placed before
  // the first visible line that starts at or after the cut's byte offset.
  const cutPos = useMemo(
    () => computeCutPos(parser, rows),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [parser, version, rows],
  );
  const merged = useMemo(() => {
    const out = new Int32Array(rows.length + cutPos.length);
    let r = 0;
    let c = 0;
    let o = 0;
    while (r < rows.length || c < cutPos.length) {
      if (c < cutPos.length && (cutPos[c] as number) <= r) out[o++] = ~c++;
      else out[o++] = r++;
    }
    return out;
  }, [rows, cutPos]);
  const pendingText = parser.pendingText;
  const footerCount = log.truncated || log.loadingMore ? 1 : 0;
  const total = merged.length + (pendingText ? 1 : 0) + footerCount;
  const numberWidth = String(Math.max(parser.lineCount, 1)).length;
  const { matches, byLine, token } = useMatches(parser.lines, version, deferredQuery);
  const safeIdx = matches.length === 0 ? 0 : Math.min(matchIdx, matches.length - 1);
  const currentMatch = matches[safeIdx];

  // Group sizes for folded headers.
  const groupSizes = useMemo(() => {
    const sizes = new Map<number, number>();
    for (const g of parser.groups)
      if (g.id !== 0) sizes.set(g.id, (g.endLine ?? parser.lineCount - 1) - g.startLine);
    return sizes;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [parser, version]);

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_H,
    overscan: 24,
    ...(wrap ? { measureElement: (el: Element) => el.getBoundingClientRect().height } : {}),
  });

  useEffect(() => {
    virtualizer.measure();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap]);

  const scrollToRow = useCallback(
    (rowIdx: number, align: "start" | "center" | "end" = "center") => {
      lastProgrammatic.current = Date.now();
      virtualizer.scrollToIndex(rowIdx, { align });
    },
    [virtualizer],
  );

  /** Expand every collapsed group that holds `lineIndex`, then scroll to it. */
  const revealLine = useCallback(
    (lineIndex: number, align: "start" | "center" = "center") => {
      const line = parser.lines[lineIndex];
      if (!line) return;
      let next: Map<number, boolean> | null = null;
      for (let g = line.group; g !== 0; g = parser.groups[g]?.parent ?? 0) {
        if (isCollapsed(parser, g, next ?? overrides)) {
          next ??= new Map(overrides);
          next.set(g, false);
        }
      }
      if (next) setOverrides(next);
      const visible = next ? visibleLines(parser, next) : rows;
      // Binary search: `visible` is sorted ascending.
      let lo = 0;
      let hi = visible.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((visible[mid] as number) < lineIndex) lo = mid + 1;
        else hi = mid;
      }
      setFollow(false);
      const cutsBefore = computeCutPos(parser, visible).filter((p) => p <= lo).length;
      requestAnimationFrame(() => scrollToRow(lo + cutsBefore, align));
    },
    [parser, overrides, rows, scrollToRow],
  );

  // Follow the tail as lines arrive.
  useLayoutEffect(() => {
    if (!follow || total === 0) return;
    lastProgrammatic.current = Date.now();
    virtualizer.scrollToIndex(total - 1, { align: "end" });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, total, version]);

  // Scroll to a permalinked selection once the lines exist.
  useEffect(() => {
    if (didInitialScroll.current || !selection || parser.lineCount <= selection.b) return;
    didInitialScroll.current = true;
    revealLine(selection.a);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, version]);

  // A permalink past the loaded window pulls in more of the log until the line exists.
  useEffect(() => {
    if (
      selection &&
      parser.lineCount <= selection.b &&
      log.truncated &&
      !log.loadingMore &&
      log.status === "ready"
    )
      log.loadMore();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, version, log.truncated, log.loadingMore, log.status]);

  // A finished attempt with no permalink opens at its first error.
  useEffect(() => {
    if (didInitialScroll.current || selection || active || log.status !== "ready") return;
    const first = parser.annotations.find((a) => a.level === "error");
    if (!first) return;
    didInitialScroll.current = true;
    revealLine(first.lineIndex);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [version, log.status, active]);

  // Stop following when the reader scrolls away; track the step in view.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (!atBottom && Date.now() - lastProgrammatic.current > 200) setFollow(false);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stop = (e: Event) => {
      if (e instanceof WheelEvent && e.deltaY >= 0) return;
      setFollow(false);
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
    };
  }, [log.status]);

  const select = useCallback(
    (line: number, extend: boolean) => {
      let next: Selection;
      if (extend && anchor.current !== null)
        next = { a: Math.min(anchor.current, line), b: Math.max(anchor.current, line) };
      else {
        anchor.current = line;
        next =
          selection && selection.a === line && selection.b === line ? null : { a: line, b: line };
      }
      setSelection(next);
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${hashFor(next)}`,
      );
    },
    [selection],
  );

  const toggleGroup = useCallback(
    (g: number) => {
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(g, !isCollapsed(parser, g, prev));
        return next;
      });
    },
    [parser],
  );

  const gotoMatch = useCallback(
    (idx: number) => {
      if (matches.length === 0) return;
      const i = ((idx % matches.length) + matches.length) % matches.length;
      setMatchIdx(i);
      revealLine((matches[i] as Match).line);
    },
    [matches, revealLine],
  );

  // First match scrolls into view when the query changes.
  useEffect(() => {
    setMatchIdx(0);
    if (deferredQuery && matches.length > 0) revealLine((matches[0] as Match).line);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery]);

  const textOf = (a: number, b: number): string => {
    const out: string[] = [];
    for (let i = a; i <= b && i < parser.lineCount; i++) {
      const l = parser.lines[i] as LogLine;
      out.push(showTime && l.ts !== null ? `${new Date(l.ts).toISOString()} ${l.text}` : l.text);
    }
    return out.join("\n");
  };

  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      toast("Copy was blocked by the browser. Select the text and copy it instead.", "error");
    }
  };

  const copyLines = () =>
    selection
      ? copy(
          textOf(selection.a, selection.b),
          selection.a === selection.b
            ? `Copied line ${selection.a + 1}`
            : `Copied lines ${selection.a + 1} to ${selection.b + 1}`,
        )
      : copy(
          textOf(0, parser.lineCount - 1),
          `Copied ${parser.lineCount.toLocaleString("en")} lines`,
        );

  const copyLink = () => {
    if (!selection) return;
    void copy(
      `${window.location.origin}${window.location.pathname}${window.location.search}${hashFor(selection)}`,
      "Link copied",
    );
  };

  const download = async () => {
    if (!attemptId || downloading) return;
    setDownloading(true);
    try {
      await downloadRawLog(attemptId, filename);
    } catch {
      toast("Could not download the log. Try again.", "error");
    } finally {
      setDownloading(false);
    }
  };

  // Shortcuts that apply while the log has focus or nothing else does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "f" &&
        scrollRef.current?.contains(document.activeElement)
      ) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "c" &&
        selection &&
        !window.getSelection()?.toString() &&
        !typing
      ) {
        e.preventDefault();
        void copyLines();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      switch (e.key) {
        case "f":
          setFollow((v) => !v);
          break;
        case "w":
          setWrap((v) => !v);
          break;
        case "t":
          setShowTime((v) => !v);
          break;
        case "/":
          e.preventDefault();
          setSearchOpen(true);
          requestAnimationFrame(() => searchRef.current?.focus());
          break;
        case "n":
          gotoMatch(safeIdx + 1);
          break;
        case "N":
          gotoMatch(safeIdx - 1);
          break;
        case "Escape":
          if (selection) {
            setSelection(null);
            history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
          }
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, gotoMatch, safeIdx, parser, showTime]);

  const jumpToLine = useCallback(
    (lineIndex: number) => {
      setNavOpen(false);
      setSelection({ a: lineIndex, b: lineIndex });
      anchor.current = lineIndex;
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#L${lineIndex + 1}`,
      );
      revealLine(lineIndex, "start");
    },
    [revealLine],
  );

  const jumpToOffset = useCallback(
    (offset: number) => {
      const idx = parser.lineAtOffset(offset);
      if (idx < 0) return;
      setNavOpen(false);
      revealLine(idx, "start");
    },
    [parser, revealLine],
  );

  // Lines where a step begins, resolved from the out-of-band step events.
  const stepStarts = useMemo(() => {
    const m = new Map<number, (typeof parser.steps)[number]>();
    for (const st of parser.steps) {
      const idx = parser.lineAtOffset(st.startOffset);
      if (idx >= 0 && !m.has(idx)) m.set(idx, st);
    }
    return m;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [parser, version]);

  const items = virtualizer.getVirtualItems();
  const firstRow = items[0]?.index ?? 0;
  useEffect(() => {
    const m = merged[Math.min(firstRow, merged.length - 1)] ?? 0;
    const pos = m >= 0 ? m : (cutPos[~m] ?? 0);
    const lineIdx = rows[Math.min(pos, rows.length - 1)];
    const step =
      lineIdx === undefined ? 0 : parser.stepAtOffset(parser.lines[lineIdx]?.offset ?? 0);
    setActiveStep((s) => (s === step ? s : step));
  }, [firstRow, merged, cutPos, rows, parser]);
  const widthCh = Math.min(parser.maxCols, 600) + numberWidth + 3 + (showTime ? 13 : 0) + 4;

  const sidebar = (
    <LogSidebar
      steps={parser.steps}
      annotations={parser.annotations}
      attemptState={attemptState}
      truncated={log.truncated}
      activeStep={activeStep}
      onJumpLine={jumpToLine}
      onJumpOffset={jumpToOffset}
      className="h-full"
    />
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-background",
        className,
      )}
    >
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-subtle px-2 py-1.5">
        <Button
          variant="ghost"
          size="xs"
          className="lg:hidden"
          onClick={() => setNavOpen(true)}
          aria-label="Open steps and annotations"
        >
          <ListTree />
          Steps
        </Button>
        {searchOpen || query ? (
          <div className="flex items-center gap-1 rounded-md border border-line-strong bg-surface pl-2">
            <Search className="size-3.5 text-faint" aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  gotoMatch(e.shiftKey ? safeIdx - 1 : safeIdx + 1);
                } else if (e.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                  (e.target as HTMLElement).blur();
                }
              }}
              placeholder="Search log"
              aria-label="Search log"
              spellCheck={false}
              autoComplete="off"
              className="h-7 w-32 bg-transparent text-xs outline-none placeholder:text-faint sm:w-44"
            />
            <span className="tabular w-16 text-center text-xs text-dim" aria-live="polite">
              {query
                ? matches.length === 0
                  ? "No match"
                  : `${safeIdx + 1} of ${matches.length >= 5000 ? "5000+" : matches.length}`
                : ""}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => gotoMatch(safeIdx - 1)}
              disabled={matches.length === 0}
              aria-label="Previous match"
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => gotoMatch(safeIdx + 1)}
              disabled={matches.length === 0}
              aria-label="Next match"
            >
              <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                setQuery("");
                setSearchOpen(false);
              }}
              aria-label="Close search"
            >
              <X />
            </Button>
          </div>
        ) : (
          <Tooltip
            label={
              <span className="flex items-center gap-2">
                Search <Kbd className="border-transparent bg-transparent text-background">/</Kbd>
              </span>
            }
          >
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setSearchOpen(true);
                requestAnimationFrame(() => searchRef.current?.focus());
              }}
            >
              <Search />
              Search
            </Button>
          </Tooltip>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-0.5">
          <Tooltip label="Keep the view pinned to new output (f)">
            <Toggle pressed={follow} onPressedChange={setFollow}>
              <ArrowDownToLine />
              Follow
            </Toggle>
          </Tooltip>
          <Tooltip label="Wrap long lines (w)">
            <Toggle pressed={wrap} onPressedChange={setWrap}>
              <WrapText />
              Wrap
            </Toggle>
          </Tooltip>
          <Tooltip label="Show timestamps (t)">
            <Toggle pressed={showTime} onPressedChange={setShowTime}>
              <Clock />
              Time
            </Toggle>
          </Tooltip>
          <span className="mx-1 hidden h-4 w-px bg-line-strong sm:block" aria-hidden="true" />
          {selection ? (
            <Tooltip label="Copy a link to the selected lines">
              <Button variant="ghost" size="xs" onClick={copyLink}>
                <Link2 />
                Link
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip
            label={
              selection ? `Copy the selected lines (${modKey()} C)` : "Copy the whole loaded log"
            }
          >
            <Button variant="ghost" size="xs" onClick={() => void copyLines()}>
              <Copy />
              {selection ? "Copy lines" : "Copy"}
            </Button>
          </Tooltip>
          <Tooltip label="Download the complete raw log">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void download()}
              disabled={!attemptId || downloading}
            >
              <Download />
              {downloading ? "Downloading" : "Raw"}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="hidden w-64 shrink-0 border-r border-line lg:block">{sidebar}</div>
        <div className="relative min-w-0 flex-1">
          {log.status === "error" ? (
            <ErrorState
              title="Could not load the log"
              message={log.error ?? "The request failed."}
              onRetry={log.retry}
            />
          ) : log.status === "loading" ? (
            <div role="status" aria-label="Loading log" className="log-root h-full space-y-2 p-4">
              {Array.from({ length: 14 }, (_, i) => (
                <Skeleton key={i} className="h-3.5" style={{ width: `${30 + ((i * 37) % 55)}%` }} />
              ))}
            </div>
          ) : (
            <div
              ref={scrollRef}
              onScroll={onScroll}
              role="log"
              aria-label="Job log"
              aria-live="off"
              tabIndex={0}
              className="log-root h-full overflow-auto overscroll-contain focus-visible:-outline-offset-2"
              style={{ tabSize: 4 }}
            >
              {total === 0 ? (
                <p className="p-4 font-sans text-sm text-dim">
                  {active ? "Waiting for the first output." : "This attempt produced no output."}
                </p>
              ) : (
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    width: wrap ? "100%" : `max(100%, ${widthCh}ch)`,
                    position: "relative",
                  }}
                >
                  {items.map((v) => {
                    if (v.index >= merged.length) {
                      const isPending = pendingText && v.index === merged.length;
                      if (isPending) {
                        return (
                          <div
                            key="pending"
                            ref={wrap ? virtualizer.measureElement : undefined}
                            data-index={v.index}
                            data-wrap={wrap}
                            className="log-row"
                            style={{ transform: `translateY(${v.start}px)` }}
                          >
                            <div
                              className="log-gutter"
                              style={{ width: `${numberWidth + 3 + (showTime ? 13 : 0)}ch` }}
                            />
                            <div className="min-w-0 flex-1 pr-4 text-faint">{pendingText}</div>
                          </div>
                        );
                      }
                      return (
                        <div
                          key="footer"
                          data-index={v.index}
                          className="log-row items-center font-sans"
                          data-kind="cut"
                          style={{ transform: `translateY(${v.start}px)` }}
                        >
                          <div className="sticky left-0 flex w-full items-center justify-center gap-3 text-[13px]">
                            <span>
                              {log.loadingMore
                                ? "Loading more"
                                : `Showing the first ${formatBytes(parser.nextOffset)} of ${formatBytes(log.knownSize)}. The view holds ${formatBytes(VIEW_CAP)} at a time.`}
                            </span>
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={log.loadMore}
                              disabled={log.loadingMore}
                            >
                              Load more
                            </Button>
                          </div>
                        </div>
                      );
                    }
                    const m = merged[v.index] as number;
                    if (m < 0) {
                      const cut = parser.cuts[~m] as (typeof parser.cuts)[number];
                      return (
                        <div
                          key={`cut-${cut.atOffset}`}
                          data-index={v.index}
                          data-kind="cut"
                          className="log-row items-center font-sans"
                          style={{ transform: `translateY(${v.start}px)` }}
                        >
                          <div className="sticky left-0 flex w-full items-center justify-center gap-2 text-[13px]">
                            <Scissors className="size-3.5" aria-hidden="true" />
                            {formatBytes(cut.omittedBytes)} of output omitted to stay within the
                            size cap
                          </div>
                        </div>
                      );
                    }
                    const lineIdx = rows[m] as number;
                    const line = parser.lines[lineIdx] as LogLine;
                    const ms = byLine.get(lineIdx);
                    return (
                      <LogRow
                        key={lineIdx}
                        line={line}
                        styles={parser.styles}
                        start={v.start}
                        numberWidth={numberWidth}
                        showTime={showTime}
                        wrap={wrap}
                        selected={
                          selection !== null && lineIdx >= selection.a && lineIdx <= selection.b
                        }
                        matches={ms}
                        current={currentMatch && ms ? ms.indexOf(currentMatch) : -1}
                        collapsed={
                          line.kind === "group" ? isCollapsed(parser, line.ref, overrides) : false
                        }
                        groupSize={line.kind === "group" ? (groupSizes.get(line.ref) ?? 0) : 0}
                        stepStart={stepStarts.get(lineIdx)}
                        measure={wrap ? virtualizer.measureElement : undefined}
                        index={v.index}
                        onSelect={select}
                        onToggle={toggleGroup}
                      />
                    );
                  })}
                </div>
              )}
              <span hidden data-match-token={token} />
            </div>
          )}
          {log.status === "ready" && !follow && active && total > 0 ? (
            <Button
              size="sm"
              className="enter absolute bottom-4 right-6 shadow-[0_4px_20px_rgb(0_0_0/0.25)]"
              onClick={() => {
                setFollow(true);
              }}
            >
              <ArrowDownToLine />
              Jump to latest
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-line bg-subtle px-3 py-1.5 text-xs text-dim">
        <span className="tabular">{parser.lineCount.toLocaleString("en")} lines</span>
        <span className="tabular">{formatBytes(parser.nextOffset)}</span>
        {selection ? (
          <span className="tabular">
            {selection.a === selection.b
              ? `Line ${selection.a + 1} selected`
              : `Lines ${selection.a + 1} to ${selection.b + 1} selected`}
          </span>
        ) : null}
        <span className="ml-auto" aria-live="polite">
          {active
            ? log.complete
              ? "Finished"
              : follow
                ? "Following live output"
                : "Live output paused"
            : log.complete
              ? "Complete"
              : log.truncated
                ? "Partial view"
                : ""}
        </span>
      </div>

      <Dialog open={navOpen} onOpenChange={setNavOpen}>
        <DialogContent
          className="top-auto bottom-0 left-0 max-h-[75dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none p-0 lg:hidden"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">Steps and annotations</DialogTitle>
          <DialogDescription className="sr-only">
            Jump to a step or an annotation in the log.
          </DialogDescription>
          <div className="h-[70dvh]">{sidebar}</div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
