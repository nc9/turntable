// REST adapter: routes generated from the registry under /api/v1. It translates HTTP to a
// dispatch call and back, and decides nothing about access: authn, scope, roles, validation and
// audit all live in dispatch().
import { type DispatchEnv, dispatch } from "./dispatch";
import type { Op } from "./define";
import { OpError, errorBody } from "./errors";
import { inputJsonSchema, type JsonSchema } from "./json-schema";

export const API_PREFIX = "/api/v1";
const MAX_BODY_BYTES = 64 * 1024;

export const API_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

type Route = {
  op: Op;
  pattern: RegExp;
  params: string[];
  types: Record<string, string | undefined>;
};

function compile(op: Op): Route {
  const params: string[] = [];
  const source = op.http.path
    .split(/(\{[a-z_][a-z0-9_]*\})/)
    .map((part) => {
      const m = /^\{(.+)\}$/.exec(part);
      if (!m) return part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
      params.push(m[1]!);
      return "([^/]+)";
    })
    .join("");
  const props = inputJsonSchema(op).properties ?? {};
  const types = Object.fromEntries(
    Object.entries(props).map(([k, v]) => [
      k,
      v.type ??
        // A union of integer and a literal string (events `after`): numbers stay numbers.
        (Array.isArray(v.anyOf) && v.anyOf.some((a: { type?: string }) => a.type === "integer")
          ? "integer_or_string"
          : undefined),
    ]),
  );
  return { op, pattern: new RegExp(`^${source}$`), params, types };
}

/** Query and path values are strings; give them the type the schema declares. */
function coerce(value: string, type: string | undefined): unknown {
  // Arrays travel comma-separated in a query string: ?types=run.queued,job.state_changed
  if (type === "array") return value === "" ? [] : value.split(",");
  if (type === "integer_or_string") return /^\d+$/.test(value) ? Number(value) : value;
  if (type === "integer" || type === "number") {
    return value.trim() === "" ? value : Number(value);
  }
  if (type === "boolean") return value === "true" ? true : value === "false" ? false : value;
  return value;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...API_HEADERS, "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function failure(err: OpError, extra: Record<string, string> = {}): Response {
  return json(errorBody(err), err.status, extra);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new OpError("payload_too_large", "request body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    throw new OpError("payload_too_large", "request body too large");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpError("invalid_input", "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpError("invalid_input", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Builds the handler for `/api/v1/*`. Returns undefined for paths outside the API so the caller
 * can fall through. Only `auth.type === "token"` ops get routes.
 */
export function createRestApi(env: DispatchEnv): (req: Request) => Promise<Response | undefined> {
  const routes = env.registry.tokenOps().map(compile);
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return undefined;
    const path = url.pathname.slice(API_PREFIX.length) || "/";

    let matched: { route: Route; values: string[] } | undefined;
    const allowed: string[] = [];
    for (const route of routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      if (route.op.http.method === req.method) matched ??= { route, values: m.slice(1) };
      else allowed.push(route.op.http.method);
    }
    if (!matched) {
      return allowed.length > 0
        ? failure(new OpError("method_not_allowed", "method not allowed"), {
            allow: [...new Set(allowed)].join(", "),
          })
        : failure(new OpError("not_found", "no such route"));
    }
    const { route, values } = matched;

    const header = req.headers.get("authorization") ?? "";
    const bearer = /^Bearer +(\S+)$/i.exec(header);
    try {
      const input: Record<string, unknown> = {};
      for (const [key, value] of url.searchParams) {
        if (key in input) throw new OpError("invalid_input", `repeated query parameter: ${key}`);
        input[key] = coerce(value, route.types[key]);
      }
      if (req.method !== "GET") Object.assign(input, await readBody(req));
      route.params.forEach((name, i) => {
        input[name] = coerce(decodeURIComponent(values[i]!), route.types[name]);
      });

      if (!bearer) {
        return failure(new OpError("unauthenticated", "missing bearer token"), {
          "www-authenticate": 'Bearer realm="longshore"',
        });
      }
      const result = await dispatch(
        env,
        { kind: "bearer", token: bearer[1]! },
        route.op.name,
        input,
      );
      if (!result.ok) {
        return failure(
          result.error,
          result.error.code === "unauthenticated"
            ? { "www-authenticate": 'Bearer realm="longshore"' }
            : {},
        );
      }
      return json(
        result.output,
        200,
        result.untrusted ? { "x-longshore-untrusted-content": "true" } : {},
      );
    } catch (err) {
      if (err instanceof OpError) return failure(err);
      console.error("longshore: REST adapter error", err);
      return failure(new OpError("internal", "internal error"));
    }
  };
}

export type { JsonSchema };
