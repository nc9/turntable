// A linear-time line matcher for agent-supplied patterns. JavaScript's RegExp backtracks, so a
// hostile pattern like (a+)+$ can pin a thread for minutes and no timeout can interrupt a single
// exec. Bun has no RE2, so this compiles a small RE2-like subset to an NFA and simulates it with
// a state set: O(pattern states x line length), whatever the pattern.
//
// Supported: literals, `.`, classes `[a-z]` `[^x]`, `\d \D \w \W \s \S`, escaped punctuation,
// `^ $ \b`, groups `( )` and `(?: )`, alternation `|`, and `* + ? {n} {n,} {n,m}` (a trailing `?`
// for lazy is accepted and ignored: only whether a line matches is reported). Not supported, and
// refused: backreferences, lookaround, named groups, flags in the pattern.

export class SafeRegexError extends Error {}

const MAX_PATTERN = 200;
const MAX_STATES = 2000;
const MAX_REPEAT = 100;

type Ast =
  | { t: "set"; test: (c: number) => boolean }
  | { t: "cat"; items: Ast[] }
  | { t: "alt"; items: Ast[] }
  | { t: "rep"; item: Ast; min: number; max: number } // max -1: unbounded
  | { t: "assert"; kind: "bol" | "eol" | "word" };

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isWord = (c: number): boolean =>
  isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpace = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;

const CLASS_ESCAPES: Record<string, (c: number) => boolean> = {
  d: isDigit,
  D: (c) => !isDigit(c),
  w: isWord,
  W: (c) => !isWord(c),
  s: isSpace,
  S: (c) => !isSpace(c),
};
const CHAR_ESCAPES: Record<string, number> = { t: 9, n: 10, r: 13 };

class Parser {
  #i = 0;
  readonly src: string;
  readonly ignoreCase: boolean;
  constructor(src: string, ignoreCase: boolean) {
    this.src = src;
    this.ignoreCase = ignoreCase;
  }

  parse(): Ast {
    const ast = this.#alt();
    if (this.#i < this.src.length) throw new SafeRegexError("unbalanced )");
    return ast;
  }

  #peek(): string | undefined {
    return this.src[this.#i];
  }

  #alt(): Ast {
    const items = [this.#cat()];
    while (this.#peek() === "|") {
      this.#i++;
      items.push(this.#cat());
    }
    return items.length === 1 ? items[0]! : { t: "alt", items };
  }

  #cat(): Ast {
    const items: Ast[] = [];
    for (let c = this.#peek(); c !== undefined && c !== "|" && c !== ")"; c = this.#peek()) {
      items.push(this.#quantified());
    }
    return { t: "cat", items };
  }

  #quantified(): Ast {
    let atom = this.#atom();
    for (;;) {
      const c = this.#peek();
      let min: number;
      let max: number;
      if (c === "*") [min, max] = [0, -1];
      else if (c === "+") [min, max] = [1, -1];
      else if (c === "?") [min, max] = [0, 1];
      else if (c === "{") {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.src.slice(this.#i));
        if (!m) return atom; // a literal brace
        min = Number(m[1]);
        max = m[2] ? (m[3] === "" ? -1 : Number(m[3])) : min;
        if (min > MAX_REPEAT || max > MAX_REPEAT || (max !== -1 && max < min)) {
          throw new SafeRegexError(`repeat counts are limited to ${MAX_REPEAT}`);
        }
        this.#i += m[0].length - 1;
      } else return atom;
      this.#i++;
      if (this.#peek() === "?") this.#i++; // lazy: same lines match
      atom = { t: "rep", item: atom, min, max };
    }
  }

  #lit(code: number): Ast {
    if (this.ignoreCase) {
      const ch = String.fromCharCode(code);
      const lo = ch.toLowerCase().charCodeAt(0);
      const up = ch.toUpperCase().charCodeAt(0);
      return { t: "set", test: (c) => c === lo || c === up || c === code };
    }
    return { t: "set", test: (c) => c === code };
  }

  #atom(): Ast {
    const ch = this.#peek()!;
    this.#i++;
    switch (ch) {
      case "(": {
        if (this.#peek() === "?") {
          if (this.src.startsWith("?:", this.#i)) this.#i += 2;
          else throw new SafeRegexError("lookaround, named groups and flags are not supported");
        }
        const inner = this.#alt();
        if (this.#peek() !== ")") throw new SafeRegexError("unbalanced (");
        this.#i++;
        return inner;
      }
      case ".":
        return { t: "set", test: (c) => c !== 10 && c !== 13 };
      case "^":
        return { t: "assert", kind: "bol" };
      case "$":
        return { t: "assert", kind: "eol" };
      case "[":
        return this.#class();
      case "\\":
        return this.#escape();
      case "*":
      case "+":
      case "?":
        throw new SafeRegexError("nothing to repeat");
      default:
        return this.#lit(ch.charCodeAt(0));
    }
  }

  #escape(): Ast {
    const e = this.#peek();
    if (e === undefined) throw new SafeRegexError("trailing backslash");
    this.#i++;
    const cls = CLASS_ESCAPES[e];
    if (cls) return { t: "set", test: cls };
    if (e === "b") return { t: "assert", kind: "word" };
    if (/[1-9]/.test(e) || e === "k" || e === "B" || e === "p" || e === "P") {
      throw new SafeRegexError("backreferences and unicode properties are not supported");
    }
    return this.#lit(CHAR_ESCAPES[e] ?? e.charCodeAt(0));
  }

  #class(): Ast {
    let negate = false;
    if (this.#peek() === "^") {
      negate = true;
      this.#i++;
    }
    const tests: ((c: number) => boolean)[] = [];
    let first = true;
    for (;;) {
      const c = this.#peek();
      if (c === undefined) throw new SafeRegexError("unterminated [");
      this.#i++;
      if (c === "]" && !first) break;
      first = false;
      let lo: number;
      if (c === "\\") {
        const e = this.#peek();
        if (e === undefined) throw new SafeRegexError("trailing backslash");
        this.#i++;
        const cls = CLASS_ESCAPES[e];
        if (cls) {
          tests.push(cls);
          continue;
        }
        lo = CHAR_ESCAPES[e] ?? e.charCodeAt(0);
      } else lo = c.charCodeAt(0);
      let hi = lo;
      if (this.#peek() === "-" && this.src[this.#i + 1] !== "]" && this.src[this.#i + 1]) {
        this.#i++;
        const h = this.#peek()!;
        this.#i++;
        if (h === "\\") {
          const e = this.#peek();
          if (e === undefined) throw new SafeRegexError("trailing backslash");
          this.#i++;
          hi = CHAR_ESCAPES[e] ?? e.charCodeAt(0);
        } else hi = h.charCodeAt(0);
        if (hi < lo) throw new SafeRegexError("bad range in class");
      }
      const [a, b] = [lo, hi];
      if (this.ignoreCase) {
        tests.push((x) => {
          const s = String.fromCharCode(x);
          const l = s.toLowerCase().charCodeAt(0);
          const u = s.toUpperCase().charCodeAt(0);
          return (x >= a && x <= b) || (l >= a && l <= b) || (u >= a && u <= b);
        });
      } else tests.push((x) => x >= a && x <= b);
    }
    return {
      t: "set",
      test: (x) => tests.some((t) => t(x)) !== negate,
    };
  }
}

// ---- NFA ----

type State =
  | { k: "set"; test: (c: number) => boolean; next: number }
  | { k: "split"; a: number; b: number }
  | { k: "assert"; kind: "bol" | "eol" | "word"; next: number }
  | { k: "match" };

/** Builds the fragment for `ast` so that it continues to `next`; returns its entry state. */
function build(states: State[], ast: Ast, next: number): number {
  const add = (s: State): number => {
    if (states.length >= MAX_STATES) throw new SafeRegexError("pattern is too large");
    states.push(s);
    return states.length - 1;
  };
  switch (ast.t) {
    case "set":
      return add({ k: "set", test: ast.test, next });
    case "assert":
      return add({ k: "assert", kind: ast.kind, next });
    case "cat": {
      let n = next;
      for (let i = ast.items.length - 1; i >= 0; i--) n = build(states, ast.items[i]!, n);
      return n;
    }
    case "alt": {
      const entries = ast.items.map((it) => build(states, it, next));
      let e = entries.at(-1)!;
      for (let i = entries.length - 2; i >= 0; i--) e = add({ k: "split", a: entries[i]!, b: e });
      return e;
    }
    case "rep": {
      // max copies after min required ones; unbounded adds a loop.
      let n = next;
      if (ast.max === -1) {
        const split = add({ k: "split", a: -1, b: next });
        const body = build(states, ast.item, split);
        (states[split] as { k: "split"; a: number; b: number }).a = body;
        n = split;
      } else {
        for (let i = ast.min; i < ast.max; i++) {
          const body = build(states, ast.item, n);
          n = add({ k: "split", a: body, b: next });
        }
      }
      for (let i = 0; i < ast.min; i++) n = build(states, ast.item, n);
      return n;
    }
  }
}

export type LineMatcher = (line: string) => boolean;

/** Compiles `pattern`; throws SafeRegexError for anything outside the supported subset. */
export function compileSafeRegex(
  pattern: string,
  opts: { ignoreCase?: boolean } = {},
): LineMatcher {
  if (pattern.length === 0) throw new SafeRegexError("pattern is empty");
  if (pattern.length > MAX_PATTERN)
    throw new SafeRegexError(`pattern is over ${MAX_PATTERN} characters`);
  const ast = new Parser(pattern, opts.ignoreCase ?? false).parse();
  const states: State[] = [];
  const start = build(states, { t: "cat", items: [ast] }, -1);
  // The final `next: -1` means match; add the match state and point everything at it.
  const matchIdx = states.length;
  states.push({ k: "match" });
  for (const s of states) {
    if ("next" in s && s.next === -1) s.next = matchIdx;
    if (s.k === "split") {
      if (s.a === -1) s.a = matchIdx;
      if (s.b === -1) s.b = matchIdx;
    }
  }
  const entry = start === -1 ? matchIdx : start;

  return (line) => {
    const n = line.length;
    let cur = new Set<number>();
    let nxt = new Set<number>();
    const closure = (into: Set<number>, from: number, pos: number, seen: Set<number>): boolean => {
      // Follows splits and satisfied assertions; adds set/match states. True when match reached.
      const stack = [from];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const s = states[id]!;
        if (s.k === "match") return true;
        if (s.k === "split") {
          stack.push(s.a, s.b);
        } else if (s.k === "assert") {
          const prev = pos > 0 ? isWord(line.charCodeAt(pos - 1)) : false;
          const here = pos < n ? isWord(line.charCodeAt(pos)) : false;
          const ok = s.kind === "bol" ? pos === 0 : s.kind === "eol" ? pos === n : prev !== here;
          if (ok) stack.push(s.next);
        } else into.add(id);
      }
      return false;
    };
    for (let pos = 0; pos <= n; pos++) {
      const seen = new Set<number>();
      // Unanchored: a new thread may start at every position.
      if (closure(cur, entry, pos, seen)) return true;
      // States already in `cur` are set-states reached at this position; re-expand assertions
      // is unnecessary because closure ran when they were added.
      if (pos === n) break;
      const c = line.charCodeAt(pos);
      nxt = new Set();
      const seenNext = new Set<number>();
      for (const id of cur) {
        const s = states[id]! as { k: "set"; test: (c: number) => boolean; next: number };
        if (s.test(c) && closure(nxt, s.next, pos + 1, seenNext)) return true;
      }
      cur = nxt;
    }
    return false;
  };
}
