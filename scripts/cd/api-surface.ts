// CD's API-surface hold: the agent-facing operations a customer's tooling reads (check runs, the
// failure digest, logs, runs, events, and every release and approval operation) must not change
// shape under a running customer. Between the deployed and the target commit, the only change
// allowed is a NEW OPTIONAL property in a RESPONSE schema. Everything else holds the deploy:
// a path, method or parameter change, any request-body change, a removed or renamed property, a
// type change, a property becoming required, a removed (or any changed) enum value. Descriptive
// text (`description`, `title`, `summary`, `example`) is ignored, so doc edits never hold.
// Pure functions over parsed JSON: the caller reads the documents with `git show`.

type Json = unknown;
type Obj = Record<string, Json>;

const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Operations CD watches: these by name, plus every release and approval operation by name. */
const NAMED = new Set([
  "checks_for_sha",
  "failure_digest",
  "job_log",
  "list_runs",
  "get_run",
  "events",
]);
export function isWatchedOp(name: string): boolean {
  return NAMED.has(name) || /release|approv/.test(name);
}

const TEXT_KEYS = new Set(["description", "title", "summary", "example", "examples"]);

type Ctx = {
  oldDoc: Obj;
  newDoc: Obj;
  out: string[];
  seen: Set<string>;
};

function resolve(doc: Obj, node: Json): { node: Json; ref?: string } {
  if (isObj(node) && typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    let cur: Json = doc;
    for (const part of node.$ref.slice(2).split("/")) {
      cur = isObj(cur) ? cur[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
    }
    return { node: cur, ref: node.$ref };
  }
  return { node };
}

/** Compares two schema (or any JSON) nodes. `responseSide` lets a new optional property pass. */
function cmp(ctx: Ctx, a: Json, b: Json, where: string, responseSide: boolean): void {
  const ra = resolve(ctx.oldDoc, a);
  const rb = resolve(ctx.newDoc, b);
  if (ra.ref || rb.ref) {
    const key = `${ra.ref ?? ""}|${rb.ref ?? ""}|${responseSide}`;
    if (ctx.seen.has(key)) return;
    ctx.seen.add(key);
  }
  a = ra.node;
  b = rb.node;
  if (Array.isArray(a) && Array.isArray(b)) {
    const prim = (v: Json[]) => v.every((x) => typeof x !== "object" || x === null);
    if (prim(a) && prim(b)) {
      // enum, required, type lists: compared as sets.
      const sa = new Set(a.map((x) => JSON.stringify(x)));
      const sb = new Set(b.map((x) => JSON.stringify(x)));
      for (const x of sa) if (!sb.has(x)) ctx.out.push(`${where}: ${x} removed`);
      for (const x of sb) if (!sa.has(x)) ctx.out.push(`${where}: ${x} added`);
      return;
    }
    if (a.length !== b.length) ctx.out.push(`${where}: list length changed`);
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      cmp(ctx, a[i], b[i], `${where}[${i}]`, responseSide);
    return;
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (TEXT_KEYS.has(k)) continue;
      if (k === "properties" && isObj(a.properties) && isObj(b.properties)) {
        const reqNew = new Set(Array.isArray(b.required) ? (b.required as string[]) : []);
        for (const p of new Set([...Object.keys(a.properties), ...Object.keys(b.properties)])) {
          const inOld = p in a.properties;
          const inNew = p in b.properties;
          if (inOld && inNew)
            cmp(ctx, a.properties[p], b.properties[p], `${where}.${p}`, responseSide);
          else if (inOld) ctx.out.push(`${where}.${p}: property removed or renamed`);
          else if (!responseSide) ctx.out.push(`${where}.${p}: property added to a request`);
          else if (reqNew.has(p)) ctx.out.push(`${where}.${p}: new property is required`);
          // else: a new optional response property, the one allowed change
        }
        continue;
      }
      if (
        k === "required" &&
        responseSide &&
        Array.isArray(a.required ?? []) &&
        Array.isArray(b.required ?? [])
      ) {
        // A new property may not be required; the old ones must keep exactly their requiredness.
        const oldReq = new Set((a.required ?? []) as string[]);
        const oldProps = isObj(a.properties) ? a.properties : {};
        const newReq = new Set((b.required ?? []) as string[]);
        for (const r of newReq)
          if (!oldReq.has(r) && r in oldProps) ctx.out.push(`${where}.${r}: became required`);
        for (const r of oldReq)
          if (!newReq.has(r)) ctx.out.push(`${where}.${r}: no longer required`);
        continue;
      }
      if (!(k in a)) ctx.out.push(`${where}.${k}: added`);
      else if (!(k in b)) ctx.out.push(`${where}.${k}: removed`);
      else cmp(ctx, a[k], b[k], `${where}.${k}`, responseSide);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    ctx.out.push(
      `${where}: changed from ${JSON.stringify(a)} to ${JSON.stringify(b)}`.slice(0, 200),
    );
  }
}

type OpAt = { path: string; method: string; op: Obj };

function operations(doc: Obj): Map<string, OpAt> {
  const out = new Map<string, OpAt>();
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (isObj(op) && typeof op.operationId === "string") {
        out.set(op.operationId, { path, method, op });
      }
    }
  }
  return out;
}

const sortedParams = (p: Json): Json =>
  Array.isArray(p)
    ? [...p].sort((x, y) =>
        JSON.stringify([isObj(x) && x.in, isObj(x) && x.name]).localeCompare(
          JSON.stringify([isObj(y) && y.in, isObj(y) && y.name]),
        ),
      )
    : p;

/** Reasons the OpenAPI documents differ in a way that holds a deploy; empty when none. */
export function diffOpenApi(oldDoc: Json, newDoc: Json): string[] {
  if (!isObj(oldDoc) || !isObj(newDoc)) return ["docs/openapi.json is not a JSON object"];
  const ctx: Ctx = { oldDoc, newDoc, out: [], seen: new Set() };
  const before = operations(oldDoc);
  const after = operations(newDoc);
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of [...names].sort()) {
    if (!isWatchedOp(name)) continue;
    const a = before.get(name);
    const b = after.get(name);
    if (!a || !b) {
      ctx.out.push(`${name}: operation ${a ? "removed" : "added"}`);
      continue;
    }
    if (a.path !== b.path || a.method !== b.method) {
      ctx.out.push(
        `${name}: moved from ${a.method.toUpperCase()} ${a.path} to ${b.method.toUpperCase()} ${b.path}`,
      );
    }
    cmp(
      ctx,
      sortedParams(a.op.parameters),
      sortedParams(b.op.parameters),
      `${name} parameters`,
      false,
    );
    cmp(ctx, a.op.requestBody, b.op.requestBody, `${name} request body`, false);
    cmp(ctx, a.op.security, b.op.security, `${name} security`, false);
    cmp(ctx, a.op.responses, b.op.responses, `${name} response`, true);
  }
  return ctx.out;
}

/** Reasons the MCP tool lists (name and input schema) differ for watched tools; empty when none. */
export function diffMcpTools(oldList: Json, newList: Json): string[] {
  const tools = (v: Json): Map<string, Json> => {
    const m = new Map<string, Json>();
    if (Array.isArray(v))
      for (const t of v) if (isObj(t) && typeof t.name === "string") m.set(t.name, t.inputSchema);
    return m;
  };
  const ctx: Ctx = { oldDoc: {}, newDoc: {}, out: [], seen: new Set() };
  const a = tools(oldList);
  const b = tools(newList);
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!isWatchedOp(name)) continue;
    if (!a.has(name) || !b.has(name))
      ctx.out.push(`MCP tool ${name}: ${a.has(name) ? "removed" : "added"}`);
    else cmp(ctx, a.get(name), b.get(name), `MCP tool ${name} input`, false);
  }
  return ctx.out;
}
