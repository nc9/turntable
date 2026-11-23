/**
 * GitHub Actions expression evaluator (the subset Turntable needs to plan and schedule jobs).
 *
 * Supported: literals (null, booleans, numbers, 'strings' with '' escapes), contexts with `.name`
 * and `['name']` access (case-insensitive), `! == != < <= > >= && ||`, parentheses, and the
 * functions success, failure, always, cancelled, contains, startsWith, endsWith, fromJSON,
 * toJSON, join, format. Anything else (hashFiles, `.*` filters, unknown functions) throws
 * ExprError naming the feature, so a plan never silently guesses.
 */

export class ExprError extends Error {
  readonly feature: string;
  constructor(feature: string, message: string) {
    super(message);
    this.name = "ExprError";
    this.feature = feature;
  }
}

export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };

export interface ExprContext {
  /** Context objects by name: github, needs, matrix, inputs, vars, env, secrets, runner, job... */
  contexts: Readonly<Record<string, Value>>;
  /** Result of the needs graph for success(), failure(), cancelled(). */
  status: { needs: readonly string[]; cancelled: boolean };
}

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "'") {
      let s = "";
      i += 1;
      for (;;) {
        if (i >= src.length) throw new ExprError("syntax", "unterminated string");
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        s += src[i];
        i += 1;
      }
      out.push({ t: "str", v: s });
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^-?(0x[0-9a-fA-F]+|[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?)/.exec(src.slice(i));
      if (!m) throw new ExprError("syntax", `bad number at ${i}`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
        out.push({ t: "op", v: two });
        i += 2;
      } else if ("!<>()[].,*".includes(c)) {
        out.push({ t: "op", v: c });
        i += 1;
      } else {
        throw new ExprError("syntax", `unexpected character "${c}"`);
      }
    }
  }
  return out;
}

type Node =
  | { k: "lit"; v: Value }
  | { k: "ctx"; name: string }
  | { k: "get"; obj: Node; key: Node }
  | { k: "call"; name: string; args: Node[] }
  | { k: "not"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node };

function parse(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const isOp = (v: string): boolean => {
    const t = peek();
    return t?.t === "op" && t.v === v;
  };
  const eat = (v: string): void => {
    if (!isOp(v)) throw new ExprError("syntax", `expected "${v}"`);
    p += 1;
  };

  const primary = (): Node => {
    const t = toks[p];
    if (!t) throw new ExprError("syntax", "unexpected end of expression");
    p += 1;
    if (t.t === "num" || t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "op") {
      if (t.v === "(") {
        const e = or();
        eat(")");
        return e;
      }
      if (t.v === "!") return { k: "not", a: unary() };
      throw new ExprError("syntax", `unexpected "${t.v}"`);
    }
    if (t.v === "null") return { k: "lit", v: null };
    if (t.v === "true") return { k: "lit", v: true };
    if (t.v === "false") return { k: "lit", v: false };
    if (isOp("(")) {
      p += 1;
      const args: Node[] = [];
      if (!isOp(")")) {
        for (;;) {
          args.push(or());
          if (isOp(",")) p += 1;
          else break;
        }
      }
      eat(")");
      return { k: "call", name: t.v, args };
    }
    return { k: "ctx", name: t.v };
  };

  const postfix = (): Node => {
    let n = primary();
    for (;;) {
      if (isOp(".")) {
        p += 1;
        const t = toks[p];
        if (t?.t === "op" && t.v === "*") {
          throw new ExprError("object filter", "the .* object filter is not supported");
        }
        if (t?.t !== "id") throw new ExprError("syntax", "expected a property name after .");
        p += 1;
        n = { k: "get", obj: n, key: { k: "lit", v: t.v } };
      } else if (isOp("[")) {
        p += 1;
        const key = or();
        eat("]");
        n = { k: "get", obj: n, key };
      } else {
        return n;
      }
    }
  };

  const unary = (): Node => {
    if (isOp("!")) {
      p += 1;
      return { k: "not", a: unary() };
    }
    return postfix();
  };

  const rel = (): Node => {
    let a = unary();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
        p += 1;
        a = { k: "bin", op: t.v, a, b: unary() };
      } else {
        return a;
      }
    }
  };
  const and = (): Node => {
    let a = rel();
    while (isOp("&&")) {
      p += 1;
      a = { k: "bin", op: "&&", a, b: rel() };
    }
    return a;
  };
  function or(): Node {
    let a = and();
    while (isOp("||")) {
      p += 1;
      a = { k: "bin", op: "||", a, b: and() };
    }
    return a;
  }

  const n = or();
  if (p < toks.length) throw new ExprError("syntax", "unexpected trailing input");
  return n;
}

const isObj = (v: Value): v is { [k: string]: Value } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === "" || v === 0) return false;
  if (typeof v === "number" && Number.isNaN(v)) return false;
  return true;
}

export function toStr(v: Value): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return Array.isArray(v) ? "Array" : "Object";
}

function toNum(v: Value): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? 0 : Number(s);
  }
  return Number.NaN;
}

const isScalar = (v: Value): boolean => v === null || typeof v !== "object";

function looseEq(a: Value, b: Value): boolean {
  if (!isScalar(a) || !isScalar(b)) return a === b;
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  return toNum(a) === toNum(b);
}

function compare(a: Value, b: Value): number | undefined {
  if (!isScalar(a) || !isScalar(b)) return undefined;
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toNum(a);
  const y = toNum(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
  return x < y ? -1 : x > y ? 1 : 0;
}

function lookup(obj: Value, key: Value): Value {
  if (Array.isArray(obj)) {
    const i = typeof key === "number" ? key : Number(key);
    return Number.isInteger(i) ? (obj[i] ?? null) : null;
  }
  if (!isObj(obj)) return null;
  const k = toStr(key);
  if (k in obj) return obj[k] as Value;
  const lower = k.toLowerCase();
  for (const [name, v] of Object.entries(obj)) if (name.toLowerCase() === lower) return v;
  return null;
}

function call(name: string, args: Value[], ctx: ExprContext): Value {
  const fn = name.toLowerCase();
  const need = (n: number): void => {
    if (args.length !== n) throw new ExprError("function", `${name}() takes ${n} argument(s)`);
  };
  switch (fn) {
    case "success":
      return ctx.status.needs.every((r) => r === "success") && !ctx.status.cancelled;
    case "failure":
      return ctx.status.needs.includes("failure");
    case "cancelled":
      return ctx.status.cancelled;
    case "always":
      return true;
    case "contains": {
      need(2);
      const [search, item] = args as [Value, Value];
      if (Array.isArray(search)) return search.some((x) => looseEq(x, item));
      return toStr(search).toLowerCase().includes(toStr(item).toLowerCase());
    }
    case "startswith":
      need(2);
      return toStr(args[0] as Value)
        .toLowerCase()
        .startsWith(toStr(args[1] as Value).toLowerCase());
    case "endswith":
      need(2);
      return toStr(args[0] as Value)
        .toLowerCase()
        .endsWith(toStr(args[1] as Value).toLowerCase());
    case "fromjson": {
      need(1);
      try {
        return JSON.parse(toStr(args[0] as Value)) as Value;
      } catch {
        throw new ExprError("fromJSON", "fromJSON() got invalid JSON");
      }
    }
    case "tojson":
      need(1);
      return JSON.stringify(args[0], null, 2);
    case "join": {
      if (args.length < 1 || args.length > 2)
        throw new ExprError("function", "join() takes 1 or 2 arguments");
      const sep = args.length === 2 ? toStr(args[1] as Value) : ",";
      const a = args[0] as Value;
      return Array.isArray(a) ? a.map(toStr).join(sep) : toStr(a);
    }
    case "format": {
      if (args.length < 1) throw new ExprError("function", "format() needs a format string");
      const f = toStr(args[0] as Value);
      return f.replaceAll(/\{\{|\}\}|\{(\d+)\}/g, (m, idx: string | undefined) => {
        if (m === "{{") return "{";
        if (m === "}}") return "}";
        const a = args[Number(idx) + 1];
        if (a === undefined) throw new ExprError("function", `format() has no argument {${idx}}`);
        return toStr(a);
      });
    }
    default:
      throw new ExprError(`function ${name}`, `unsupported function ${name}()`);
  }
}

function ev(n: Node, ctx: ExprContext): Value {
  switch (n.k) {
    case "lit":
      return n.v;
    case "ctx":
      return ctx.contexts[n.name] ?? ctx.contexts[n.name.toLowerCase()] ?? null;
    case "get":
      return lookup(ev(n.obj, ctx), ev(n.key, ctx));
    case "call":
      return call(
        n.name,
        n.args.map((a) => ev(a, ctx)),
        ctx,
      );
    case "not":
      return !truthy(ev(n.a, ctx));
    case "bin": {
      if (n.op === "&&") {
        const a = ev(n.a, ctx);
        return truthy(a) ? ev(n.b, ctx) : a;
      }
      if (n.op === "||") {
        const a = ev(n.a, ctx);
        return truthy(a) ? a : ev(n.b, ctx);
      }
      const a = ev(n.a, ctx);
      const b = ev(n.b, ctx);
      if (n.op === "==") return looseEq(a, b);
      if (n.op === "!=") return !looseEq(a, b);
      const c = compare(a, b);
      if (c === undefined) return false;
      return n.op === "<" ? c < 0 : n.op === "<=" ? c <= 0 : n.op === ">" ? c > 0 : c >= 0;
    }
  }
}

/** Evaluates one expression (no `${{ }}` wrapper). */
export function evaluate(expr: string, ctx: ExprContext): Value {
  return ev(parse(expr), ctx);
}

/** `${{ expr }}` when the whole string is one expression, else undefined. */
export function wholeExpression(text: string): string | undefined {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text);
  if (!m) return undefined;
  const inner = m[1] ?? "";
  return inner.includes("}}") ? undefined : inner.trim();
}

/** Evaluates a job/step `if:` value: bare expression or `${{ }}`-wrapped. Booleans pass through. */
export function evaluateCondition(cond: string | boolean | undefined, ctx: ExprContext): boolean {
  if (cond === undefined) return call("success", [], ctx) as boolean;
  if (typeof cond === "boolean") return cond;
  const whole = wholeExpression(cond);
  if (whole === undefined && cond.includes("${{")) {
    throw new ExprError("mixed if", `if: mixes text and \${{ }}: ${cond}`);
  }
  return truthy(evaluate(whole ?? cond, ctx));
}

/** Replaces every `${{ expr }}` in a string with its string value. */
export function interpolate(text: string, ctx: ExprContext): string {
  return text.replaceAll(/\$\{\{([\s\S]*?)\}\}/g, (_m, e: string) =>
    toStr(evaluate(e.trim(), ctx)),
  );
}

/** Names of the contexts an expression reads (for deciding whether it is static at plan time). */
export function referencedContexts(expr: string): Set<string> {
  const out = new Set<string>();
  const walk = (n: Node): void => {
    if (n.k === "ctx") out.add(n.name.toLowerCase());
    else if (n.k === "get") {
      walk(n.obj);
      walk(n.key);
    } else if (n.k === "call") {
      if (["success", "failure", "cancelled"].includes(n.name.toLowerCase())) out.add("status");
      n.args.forEach(walk);
    } else if (n.k === "not") walk(n.a);
    else if (n.k === "bin") {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(parse(expr));
  return out;
}
