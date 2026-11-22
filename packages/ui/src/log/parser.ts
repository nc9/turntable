/* oxlint-disable no-control-regex -- this file exists to match terminal control sequences */
// Incremental log parser. Feed it ordered byte chunks (by byte offset); it keeps only the
// unfinished tail line between pushes, so a new chunk never reparses earlier lines.
//
// Recognised input:
//   - an optional ISO-8601 timestamp prefix on each line ("2026-11-22T10:00:00.123Z ")
//   - ANSI SGR colours and styles (state carries across chunks and lines); other escapes are dropped
//   - "::group::title" / "::endgroup::" folding (nestable)
//   - "::error|warning|notice|debug <props>::message" annotations
//   - the cut marker the output cap inserts (`cutMarker()` in @turntable/provider-sdk):
//     "[turntable: N bytes of output omitted]" on its own line
//
// Step boundaries are NOT read from the log text. The server stores act's step events separately
// and delivers them out of band; feed them with `applyStep`, keyed by the log byte offset where
// the step starts. A log can therefore never forge a step.
//
// Everything else is untrusted text. Only SGR colours and styles survive: OSC (hyperlinks, titles),
// other CSI (cursor movement, erase), lone escapes, C0/C1 controls and bidi overrides are dropped.

export type Level = "error" | "warning" | "notice" | "debug";
export type LineKind = "text" | "group" | "cut";
export type StepResult = "success" | "failure" | "skipped";

/** A run of text with one style. `style` indexes `LogParser.styles`; 0 is the default style. */
export type Seg = { text: string; style: number };

export type StyleDef = { cls: string; color: string | null; background: string | null };

export type Annotation = {
  id: number;
  level: Exclude<Level, "debug">;
  message: string;
  title: string | null;
  file: string | null;
  line: number | null;
  col: number | null;
  /** Index into `LogParser.lines`. */
  lineIndex: number;
};

export type LogLine = {
  /** Zero-based index; the displayed line number is index + 1. */
  index: number;
  /** Byte offset of the line start in the raw log. */
  offset: number;
  ts: number | null;
  kind: LineKind;
  level: Level | null;
  /** Plain text without ANSI or the timestamp. */
  text: string;
  /** Styled segments, or null when the whole line has the default style. */
  segs: Seg[] | null;
  /** Innermost enclosing group id (0 when none). A group's own header belongs to its parent. */
  group: number;
  /** For kind "group": this line's own group id; otherwise 0. */
  ref: number;
  /** Bytes omitted, for kind "cut". */
  cutBytes: number;
};

export type GroupInfo = {
  id: number;
  parent: number;
  title: string;
  startLine: number;
  endLine: number | null;
  /** True when an error annotation occurred inside (so the group opens by default). */
  hasError: boolean;
};

/** An out-of-band step event, as delivered by the API (see realtime `StepMessage`). */
export type StepEventInput = {
  index: number;
  name: string;
  phase: "start" | "end";
  result?: StepResult | undefined;
  at: number;
  /** Byte offset in the log where the step starts (for "end": where it ended). */
  logOffset: number;
};

export type StepInfo = {
  index: number;
  name: string;
  /** Byte offset in the raw log where the step starts. */
  startOffset: number;
  endOffset: number | null;
  startTs: number | null;
  endTs: number | null;
  result: StepResult | null;
};

export const MAX_LINE_BYTES = 64 * 1024;

const FLAG_BOLD = 1;
const FLAG_DIM = 2;
const FLAG_ITALIC = 4;
const FLAG_UNDERLINE = 8;
const FLAG_STRIKE = 16;
const FLAG_INVERSE = 32;
const TRUE_COLOR = 0x1000000;

const ESCAPE_RE =
  /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[ -/]*[0-~])/g;
// Controls that could spoof UI chrome or hide text: C0 (except tab, CR, ESC and BEL, which are handled
// below: BEL may terminate an OSC), DEL, C1 (including the 8-bit CSI/OSC introducers), and bidirectional overrides.
const STRAY_RE = /[\u001b\u0007]/g;
const UNSAFE_RE =
  /[\u0000-\u0006\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Exactly what `cutMarker()` in @turntable/provider-sdk writes (plus its surrounding newlines).
const CUT_RE = /^\[turntable: (\d+) bytes of output omitted\]$/;
const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /;
const COMMAND_RE = /^::([A-Za-z-]+)(?: ([^\n]*?))?::(.*)$/;

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

function paletteColor(n: number): string {
  if (n < 232) {
    const i = n - 16;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return rgbHex(v(Math.floor(i / 36)), v(Math.floor(i / 6) % 6), v(i % 6));
  }
  const g = 8 + (n - 232) * 10;
  return rgbHex(g, g, g);
}

function colorValue(c: number): string {
  return c >= TRUE_COLOR ? rgbHex((c >> 16) & 255, (c >> 8) & 255, c & 255) : paletteColor(c);
}

function decodeProp(s: string): string {
  return s
    .replace(/%0A/gi, "\n")
    .replace(/%0D/gi, "\r")
    .replace(/%3A/gi, ":")
    .replace(/%2C/gi, ",")
    .replace(/%25/g, "%");
}

function parseProps(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeProp(part.slice(eq + 1));
  }
  return out;
}

const toInt = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};

/** Plain-text view of a raw fragment: same neutralisation as a full line, no styling. */
function sanitize(raw: string): string {
  let s = raw.replace(UNSAFE_RE, "");
  const cr = s.lastIndexOf("\r");
  if (cr !== -1) s = s.slice(cr + 1) || s.slice(0, cr);
  return s.replace(ESCAPE_RE, "").replace(STRAY_RE, "");
}

export class LogParser {
  readonly lines: LogLine[] = [];
  readonly groups: GroupInfo[] = [
    { id: 0, parent: 0, title: "", startLine: 0, endLine: null, hasError: false },
  ];
  readonly steps: StepInfo[] = [];
  readonly annotations: Annotation[] = [];
  readonly styles: StyleDef[] = [{ cls: "", color: null, background: null }];
  /** Longest line in characters, for sizing the horizontal scroller. */
  maxCols = 0;
  /** The next byte offset this parser expects. */
  nextOffset: number;
  /** Increments on every push that changed state. */
  version = 0;

  private readonly decoder = new TextDecoder("utf-8");
  private pending: Uint8Array = new Uint8Array(0);
  private pendingStart: number;
  private fg = -1;
  private bg = -1;
  private flags = 0;
  private styleIndex = new Map<string, number>([["-1,-1,0", 0]]);
  private groupStack: number[] = [];
  /** Escape sequence left open by a forced line split (see `consume`). */
  private carry: "none" | "osc" | "csi" | "esc" = "none";
  private continuing = false;

  constructor(startOffset = 0) {
    this.nextOffset = startOffset;
    this.pendingStart = startOffset;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** Text of the unfinished last line (no newline yet), with escapes stripped. */
  get pendingText(): string {
    if (this.pending.length === 0) return "";
    return sanitize(this.decoder.decode(this.pending));
  }

  /** Apply an out-of-band step event. Idempotent: replays after a reconnect are harmless. */
  applyStep(ev: StepEventInput): void {
    let step = this.steps.find((x) => x.index === ev.index);
    if (!step) {
      step = {
        index: ev.index,
        name: ev.name,
        startOffset: ev.logOffset,
        endOffset: null,
        startTs: null,
        endTs: null,
        result: null,
      };
      this.steps.push(step);
    }
    if (ev.phase === "start") {
      step.name = ev.name;
      step.startOffset = ev.logOffset;
      step.startTs = ev.at;
    } else {
      step.endOffset = ev.logOffset;
      step.endTs = ev.at;
      step.result = ev.result ?? "success";
    }
    this.steps.sort((a, b) => a.startOffset - b.startOffset || a.index - b.index);
    this.version += 1;
  }

  /** Index of the line containing byte `offset`, or -1 when that part of the log is not loaded. */
  lineAtOffset(offset: number): number {
    const { lines } = this;
    if (lines.length === 0 || offset < (lines[0] as LogLine).offset || offset >= this.nextOffset)
      return -1;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lines[mid] as LogLine).offset <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The step in progress at byte `offset` (0 when outside any step). */
  stepAtOffset(offset: number): number {
    let found = 0;
    for (const st of this.steps) {
      if (st.startOffset > offset) break;
      found = st.endOffset !== null && offset >= st.endOffset ? 0 : st.index;
    }
    return found;
  }

  /**
   * Feed a chunk. Chunks must arrive in order: overlap with already-seen bytes (a replay after
   * a reconnect) is skipped, a gap is rejected. Returns "ok", "duplicate" (nothing new) or "gap".
   */
  push(bytes: Uint8Array, offset: number): "ok" | "duplicate" | "gap" {
    if (offset > this.nextOffset) return "gap";
    const skip = this.nextOffset - offset;
    if (skip >= bytes.length) return "duplicate";
    const fresh = skip > 0 ? bytes.subarray(skip) : bytes;
    this.consume(fresh);
    this.nextOffset += fresh.length;
    this.version += 1;
    return "ok";
  }

  private consume(fresh: Uint8Array): void {
    let data: Uint8Array;
    let base: number;
    if (this.pending.length > 0) {
      data = new Uint8Array(this.pending.length + fresh.length);
      data.set(this.pending, 0);
      data.set(fresh, this.pending.length);
      base = this.pendingStart;
    } else {
      data = fresh;
      base = this.nextOffset;
    }
    let pos = 0;
    for (;;) {
      const nl = data.indexOf(10, pos);
      const end = nl === -1 ? data.length : nl;
      if (end - pos > MAX_LINE_BYTES) {
        // A single enormous line: split it so memory stays bounded. Never cut mid UTF-8 sequence.
        let cut = pos + MAX_LINE_BYTES;
        while (cut > pos && ((data[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
        this.processLine(this.decoder.decode(data.subarray(pos, cut)), base + pos, true);
        pos = cut;
        continue;
      }
      if (nl === -1) break;
      this.processLine(this.decoder.decode(data.subarray(pos, nl)), base + pos, false);
      pos = nl + 1;
    }
    this.pending = pos < data.length ? data.slice(pos) : new Uint8Array(0);
    this.pendingStart = base + pos;
  }

  private styleId(): number {
    const key = `${this.fg},${this.bg},${this.flags}`;
    const hit = this.styleIndex.get(key);
    if (hit !== undefined) return hit;
    let fg = this.fg;
    let bg = this.bg;
    const classes: string[] = [];
    if (this.flags & FLAG_INVERSE) [fg, bg] = [bg, fg];
    let color: string | null = null;
    let background: string | null = null;
    if (fg >= 0) {
      if (fg < 16) classes.push(`af-${fg}`);
      else color = colorValue(fg);
    }
    if (bg >= 0) {
      if (bg < 16) classes.push(`ab-${bg}`);
      else background = colorValue(bg);
    }
    if (this.flags & FLAG_BOLD) classes.push("ansi-b");
    if (this.flags & FLAG_DIM) classes.push("ansi-d");
    if (this.flags & FLAG_ITALIC) classes.push("ansi-i");
    if (this.flags & FLAG_UNDERLINE) classes.push("ansi-u");
    if (this.flags & FLAG_STRIKE) classes.push("ansi-s");
    if (this.flags & FLAG_INVERSE && fg < 0 && bg < 0) classes.push("ansi-r");
    const id = this.styles.length;
    this.styles.push({ cls: classes.join(" "), color, background });
    this.styleIndex.set(key, id);
    return id;
  }

  private applySgr(params: string): void {
    const codes =
      params === ""
        ? [0]
        : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number.parseInt(p, 10)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] ?? 0;
      if (c === 0) {
        this.fg = -1;
        this.bg = -1;
        this.flags = 0;
      } else if (c === 1) this.flags |= FLAG_BOLD;
      else if (c === 2) this.flags |= FLAG_DIM;
      else if (c === 3) this.flags |= FLAG_ITALIC;
      else if (c === 4) this.flags |= FLAG_UNDERLINE;
      else if (c === 7) this.flags |= FLAG_INVERSE;
      else if (c === 9) this.flags |= FLAG_STRIKE;
      else if (c === 22) this.flags &= ~(FLAG_BOLD | FLAG_DIM);
      else if (c === 23) this.flags &= ~FLAG_ITALIC;
      else if (c === 24) this.flags &= ~FLAG_UNDERLINE;
      else if (c === 27) this.flags &= ~FLAG_INVERSE;
      else if (c === 29) this.flags &= ~FLAG_STRIKE;
      else if (c >= 30 && c <= 37) this.fg = c - 30;
      else if (c >= 90 && c <= 97) this.fg = c - 90 + 8;
      else if (c >= 40 && c <= 47) this.bg = c - 40;
      else if (c >= 100 && c <= 107) this.bg = c - 100 + 8;
      else if (c === 39) this.fg = -1;
      else if (c === 49) this.bg = -1;
      else if (c === 38 || c === 48) {
        const mode = codes[i + 1];
        let value = -1;
        if (mode === 5) {
          value = Math.min(255, Math.max(0, codes[i + 2] ?? 0));
          i += 2;
        } else if (mode === 2) {
          const r = Math.min(255, codes[i + 2] ?? 0);
          const g = Math.min(255, codes[i + 3] ?? 0);
          const b = Math.min(255, codes[i + 4] ?? 0);
          value = TRUE_COLOR + ((r << 16) | (g << 8) | b);
          i += 4;
        } else break;
        if (c === 38) this.fg = value;
        else this.bg = value;
      }
    }
  }

  /** Splits a raw line into styled segments, advancing the carried SGR state. */
  private tokenize(raw: string): { text: string; segs: Seg[] | null } {
    let s = raw;
    const cr = s.lastIndexOf("\r");
    if (cr !== -1) {
      const tail = s.slice(cr + 1);
      s = tail.length > 0 ? tail : s.slice(0, cr);
    }
    const startedStyled = this.fg !== -1 || this.bg !== -1 || this.flags !== 0;
    if (!startedStyled && s.indexOf("\u001b") === -1)
      return { text: s.replaceAll("\u0007", ""), segs: null };
    const segs: Seg[] = [];
    let text = "";
    let last = 0;
    let styled = startedStyled;
    ESCAPE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ESCAPE_RE.exec(s)) !== null) {
      if (m.index > last) {
        const piece = s.slice(last, m.index).replace(STRAY_RE, "");
        segs.push({ text: piece, style: this.styleId() });
        text += piece;
      }
      if (m[2] === "m") {
        this.applySgr(m[1] ?? "");
        if (this.fg !== -1 || this.bg !== -1 || this.flags !== 0) styled = true;
      }
      last = m.index + m[0].length;
    }
    if (last < s.length) {
      const piece = s.slice(last).replace(STRAY_RE, "");
      segs.push({ text: piece, style: this.styleId() });
      text += piece;
    }
    return { text, segs: styled ? segs : null };
  }

  private push1(line: Omit<LogLine, "index" | "group"> & { group?: number }): LogLine {
    const full: LogLine = {
      ...line,
      index: this.lines.length,
      group: line.group ?? this.groupStack.at(-1) ?? 0,
    };
    this.lines.push(full);
    if (full.text.length > this.maxCols) this.maxCols = full.text.length;
    return full;
  }

  private markGroupsError(): void {
    for (let g = this.groupStack.at(-1) ?? 0; g !== 0; g = this.groups[g]?.parent ?? 0) {
      const info = this.groups[g];
      if (info) info.hasError = true;
    }
  }

  /** Drops the tail of an escape sequence that a forced split cut in half. */
  private stripCarry(s: string): string {
    let rest = s;
    while (this.carry !== "none") {
      if (this.carry === "esc") {
        if (rest === "") return "";
        const c = rest[0];
        rest = rest.slice(1);
        this.carry = c === "]" ? "osc" : c === "[" ? "csi" : "none";
      } else if (this.carry === "osc") {
        const m = /\u0007|\u001b\\/.exec(rest);
        if (!m) return "";
        rest = rest.slice(m.index + m[0].length);
        this.carry = "none";
      } else {
        const m = /^[0-?]*[ -/]*[@-~]/.exec(rest);
        if (!m) return /^[0-?]*[ -/]*$/.test(rest) ? "" : ((this.carry = "none"), rest);
        rest = rest.slice(m[0].length);
        this.carry = "none";
      }
    }
    return rest;
  }

  /** After a forced split, remember whether the piece ended inside an escape sequence. */
  private updateCarry(piece: string): void {
    const i = piece.lastIndexOf("\u001b");
    this.carry = "none";
    if (i === -1) return;
    const tail = piece.slice(i);
    if (tail === "\u001b") this.carry = "esc";
    else if (tail[1] === "]") {
      if (!/\u0007|\u001b\\/.test(tail.slice(2))) this.carry = "osc";
    } else if (tail[1] === "[") {
      if (!/^\u001b\[[0-?]*[ -/]*[@-~]/.test(tail)) this.carry = "csi";
    }
  }

  private processLine(inputRaw: string, offset: number, forced: boolean): void {
    const input = this.continuing && this.carry !== "none" ? this.stripCarry(inputRaw) : inputRaw;
    if (forced) this.updateCarry(inputRaw);
    else this.carry = "none";
    this.continuing = forced;
    const raw = input.replace(UNSAFE_RE, "");
    let rest = raw;
    let ts: number | null = null;
    const tsMatch = TS_RE.exec(rest);
    if (tsMatch) {
      ts = Date.parse(tsMatch[1] as string);
      rest = rest.slice(tsMatch[0].length);
    }

    const base = { offset, ts, level: null, segs: null, ref: 0, cutBytes: 0 } as const;

    const cutMatch = CUT_RE.exec(rest);
    if (cutMatch) {
      this.push1({ ...base, kind: "cut", text: "omitted", cutBytes: Number(cutMatch[1]) });
      return;
    }

    if (rest.startsWith("::")) {
      const cmd = COMMAND_RE.exec(rest.replace(/\r$/, ""));
      if (cmd) {
        const name = (cmd[1] as string).toLowerCase();
        const props = cmd[2];
        const value = cmd[3] ?? "";
        switch (name) {
          case "group": {
            const { text, segs } = this.tokenize(value);
            const parent = this.groupStack.at(-1) ?? 0;
            const id = this.groups.length;
            const line = this.push1({
              ...base,
              kind: "group",
              text: text || "Group",
              segs,
              ref: id,
              group: parent,
            });
            this.groups.push({
              id,
              parent,
              title: text || "Group",
              startLine: line.index,
              endLine: null,
              hasError: false,
            });
            this.groupStack.push(id);
            return;
          }
          case "endgroup": {
            const id = this.groupStack.pop();
            const info = id === undefined ? undefined : this.groups[id];
            if (info) info.endLine = this.lines.length - 1;
            return;
          }
          case "error":
          case "warning":
          case "notice":
          case "debug": {
            const p = parseProps(props);
            const message = decodeProp(value);
            const { text, segs } = this.tokenize(message);
            const line = this.push1({ ...base, kind: "text", level: name, text, segs });
            if (name !== "debug") {
              this.annotations.push({
                id: this.annotations.length,
                level: name,
                message,
                title: p.title ?? null,
                file: p.file ?? null,
                line: toInt(p.line),
                col: toInt(p.col),
                lineIndex: line.index,
              });
              if (name === "error") this.markGroupsError();
            }
            return;
          }
          case "add-mask":
            return;
          default:
            break;
        }
      }
    }

    const { text, segs } = this.tokenize(rest);
    this.push1({ ...base, kind: "text", text, segs });
  }
}

/** Parse a whole buffer in one go (tests, raw download preview). */
export function parseAll(bytes: Uint8Array): LogParser {
  const p = new LogParser(0);
  p.push(bytes, 0);
  return p;
}

/**
 * Which lines are visible given the group fold state. `overrides` holds explicit user choices
 * (true = collapsed); otherwise a closed group is collapsed unless it contains an error.
 */
export function visibleLines(
  parser: LogParser,
  overrides: ReadonlyMap<number, boolean>,
): Int32Array {
  const { groups, lines } = parser;
  const hidden = new Uint8Array(groups.length);
  for (let g = 1; g < groups.length; g++) {
    const info = groups[g] as GroupInfo;
    const collapsed = overrides.get(g) ?? (info.endLine !== null && !info.hasError);
    hidden[g] = collapsed || hidden[info.parent] === 1 ? 1 : 0;
  }
  const out = new Int32Array(lines.length);
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const g = (lines[i] as LogLine).group;
    if (g === 0 || hidden[g] === 0) out[n++] = i;
  }
  return out.subarray(0, n);
}

/** True when group `g` is collapsed under the given overrides. */
export function isCollapsed(
  parser: LogParser,
  g: number,
  overrides: ReadonlyMap<number, boolean>,
): boolean {
  const info = parser.groups[g];
  if (!info) return false;
  return overrides.get(g) ?? (info.endLine !== null && !info.hasError);
}
