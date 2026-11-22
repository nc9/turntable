import { ChevronDown, ChevronRight, Scissors } from "lucide-react";
import { memo, type ReactNode } from "react";
import type { LogLine, StepInfo, StyleDef } from "@/log/parser";
import type { Match } from "@/log/search";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export type RowProps = {
  line: LogLine;
  styles: readonly StyleDef[];
  start: number;
  numberWidth: number;
  showTime: boolean;
  wrap: boolean;
  selected: boolean;
  /** Matches on this line; `current` is the index into `matches` that is the active one, or -1. */
  matches: readonly Match[] | undefined;
  current: number;
  collapsed: boolean;
  /** Lines inside the group, for group headers. */
  groupSize: number;
  /** The step that begins on this line (steps come from the API, not the log text). */
  stepStart: StepInfo | undefined;
  measure: ((el: HTMLElement | null) => void) | undefined;
  index: number;
  onSelect: (line: number, extend: boolean) => void;
  onToggle: (group: number) => void;
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const formatTs = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
};

/** Splits styled segments at match boundaries and wraps matches in <mark>. */
function renderContent(
  line: LogLine,
  styles: readonly StyleDef[],
  matches: readonly Match[] | undefined,
  current: number,
): ReactNode {
  const segs = line.segs ?? [{ text: line.text, style: 0 }];
  if (!matches || matches.length === 0) {
    if (!line.segs) return line.text;
    return segs.map((s, i) => <Styled key={i} text={s.text} def={styles[s.style]} />);
  }
  const out: ReactNode[] = [];
  let pos = 0;
  let key = 0;
  for (const seg of segs) {
    const segStart = pos;
    const segEnd = pos + seg.text.length;
    let cursor = segStart;
    matches.forEach((m, mi) => {
      const a = Math.max(m.start, segStart);
      const b = Math.min(m.end, segEnd);
      if (a >= b || a < cursor) return;
      if (a > cursor)
        out.push(
          <Styled
            key={key++}
            text={seg.text.slice(cursor - segStart, a - segStart)}
            def={styles[seg.style]}
          />,
        );
      out.push(
        <mark key={key++} className="log-mark" data-current={mi === current}>
          <Styled text={seg.text.slice(a - segStart, b - segStart)} def={styles[seg.style]} />
        </mark>,
      );
      cursor = b;
    });
    if (cursor < segEnd)
      out.push(
        <Styled key={key++} text={seg.text.slice(cursor - segStart)} def={styles[seg.style]} />,
      );
    pos = segEnd;
  }
  return out;
}

function Styled({ text, def }: { text: string; def: StyleDef | undefined }) {
  if (!def || (def.cls === "" && !def.color && !def.background)) return <>{text}</>;
  const style =
    def.color || def.background
      ? {
          ...(def.color ? { color: def.color } : {}),
          ...(def.background ? { background: def.background } : {}),
        }
      : undefined;
  return (
    <span className={def.cls || undefined} style={style}>
      {text}
    </span>
  );
}

const LEVEL_LABEL = {
  error: "Error",
  warning: "Warning",
  notice: "Notice",
  debug: "Debug",
} as const;
const LEVEL_TEXT = {
  error: "text-st-failure",
  warning: "text-st-infra",
  notice: "text-st-running",
  debug: "text-faint",
} as const;

function RowImpl(p: RowProps) {
  const { line } = p;
  const lineNo = line.index + 1;
  const gutterCh = p.numberWidth + 3 + (p.showTime ? 13 : 0);
  let body: ReactNode;
  if (line.kind === "group") {
    body = (
      <button
        type="button"
        onClick={() => p.onToggle(line.ref)}
        aria-expanded={!p.collapsed}
        className="flex min-w-0 items-center gap-1.5 text-left font-semibold hover:text-foreground focus-visible:-outline-offset-2"
      >
        {p.collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-dim" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-dim" aria-hidden="true" />
        )}
        <span className={p.wrap ? "" : "truncate"}>
          {renderContent(line, p.styles, p.matches, p.current)}
        </span>
        {p.collapsed ? (
          <span className="shrink-0 font-normal text-faint">{p.groupSize} lines</span>
        ) : null}
      </button>
    );
  } else if (line.kind === "cut") {
    body = (
      <span className="flex items-center gap-2">
        <Scissors className="size-3.5" aria-hidden="true" />
        {line.cutBytes > 0 ? formatBytes(line.cutBytes) : "Some output"} of output omitted to stay
        within the size cap
      </span>
    );
  } else {
    body = (
      <>
        {line.level && line.level !== "debug" ? (
          <span className={cn("mr-2 font-semibold", LEVEL_TEXT[line.level])}>
            {LEVEL_LABEL[line.level]}
          </span>
        ) : null}
        {renderContent(line, p.styles, p.matches, p.current)}
        {line.text === "" && !line.segs ? "​" : null}
      </>
    );
  }
  return (
    <div
      ref={p.measure}
      data-index={p.index}
      data-line={lineNo}
      data-wrap={p.wrap}
      data-selected={p.selected}
      data-kind={line.kind}
      data-step-start={p.stepStart ? "" : undefined}
      data-level={line.level ?? undefined}
      className="log-row"
      style={{ transform: `translateY(${p.start}px)` }}
    >
      <div className="log-gutter" style={{ width: `${gutterCh}ch` }}>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Select line ${lineNo}`}
          onClick={(e) => p.onSelect(line.index, e.shiftKey)}
          className="cursor-pointer select-none pr-3 text-right hover:text-foreground"
          style={{ width: `${p.numberWidth + 2}ch` }}
        >
          {lineNo}
        </button>
        {p.showTime ? (
          <span className="w-[13ch] shrink-0 text-faint">
            {line.ts !== null ? formatTs(line.ts) : ""}
          </span>
        ) : null}
      </div>
      <div className={cn("min-w-0 flex-1 pr-4", line.kind === "cut" && "text-center")}>{body}</div>
    </div>
  );
}

export const LogRow = memo(RowImpl);
