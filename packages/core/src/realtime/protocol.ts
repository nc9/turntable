// Realtime wire protocol: one WebSocket at /api/v1/realtime, JSON text frames. This file is pure
// (no imports) so the web UI shares the exact types and constants the server uses.
//
// Connect:   new WebSocket(url, ["longshore.v1", "bearer.<token>"]). The token rides in
//            Sec-WebSocket-Protocol (never the query string); the server echoes only longshore.v1.
// Topics:    org                      every event in the token's grant
//            project:<slug>           events of one project
//            run:<id>                 events of one run (job and attempt changes included)
//            attempt:<id>:log         log bytes of one attempt from `from_offset`, plus its cuts
//            attempt:<id>:steps       the attempt's steps and cuts, re-sent when they change
// Every subscribe is authorized by dispatching the matching read operation as the caller.

export const REALTIME_PATH = "/api/v1/realtime";
export const SUBPROTOCOL = "longshore.v1";
export const BEARER_PREFIX = "bearer.";

/** Close codes (4000 to 4999 are application-defined). */
export const CLOSE = {
  /** The token is missing, invalid, expired or revoked. */
  unauthenticated: 4401,
  /** The client was too slow: its send buffer passed the limit. Resume from your last cursors. */
  slowClient: 4408,
  /** A per-org or per-connection limit was hit. */
  limit: 4429,
  /** No subscriptions for too long. */
  idle: 4000,
  /** The client sent something the protocol does not allow. */
  protocol: 4400,
} as const;

export type Topic =
  | { kind: "org" }
  | { kind: "project"; slug: string }
  | { kind: "run"; id: string }
  | { kind: "attempt-log"; id: string }
  | { kind: "attempt-steps"; id: string };

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseTopic(s: unknown): Topic | null {
  if (typeof s !== "string" || s.length > 160) return null;
  if (s === "org") return { kind: "org" };
  const [head, a, b, ...rest] = s.split(":");
  if (rest.length > 0) return null;
  if (head === "project" && a !== undefined && b === undefined && SLUG.test(a))
    return { kind: "project", slug: a };
  if (head === "run" && a !== undefined && b === undefined && ID.test(a))
    return { kind: "run", id: a };
  if (head === "attempt" && a !== undefined && ID.test(a)) {
    if (b === "log") return { kind: "attempt-log", id: a };
    if (b === "steps") return { kind: "attempt-steps", id: a };
  }
  return null;
}

export function formatTopic(t: Topic): string {
  switch (t.kind) {
    case "org":
      return "org";
    case "project":
      return `project:${t.slug}`;
    case "run":
      return `run:${t.id}`;
    case "attempt-log":
      return `attempt:${t.id}:log`;
    case "attempt-steps":
      return `attempt:${t.id}:steps`;
  }
}

// ---- client to server ----

export type ClientMessage =
  /** `after` resumes the event topics after a cursor (omit for "from now"); `from_offset` is for logs. */
  | { op: "subscribe"; id: string; topic: string; after?: number; from_offset?: number }
  | { op: "unsubscribe"; id: string };

export const MAX_MESSAGE_BYTES = 4096;

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return null;
  const m = j as Record<string, unknown>;
  const id = m.id;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (m.op === "unsubscribe") return { op: "unsubscribe", id };
  if (m.op !== "subscribe" || typeof m.topic !== "string") return null;
  const num = (v: unknown): number | undefined | null =>
    v === undefined
      ? undefined
      : typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        ? v
        : null;
  const after = num(m.after);
  const from = num(m.from_offset);
  if (after === null || from === null) return null;
  return {
    op: "subscribe",
    id,
    topic: m.topic,
    ...(after !== undefined ? { after } : {}),
    ...(from !== undefined ? { from_offset: from } : {}),
  };
}

// ---- server to client ----

/** One event from the feed; the same shape the `events` operation returns. */
export type WireEvent = {
  cursor: number;
  id: string;
  type: string;
  project: string | null;
  run_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type WireStep = {
  key: string;
  stage: string;
  index: number;
  name: string;
  result: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  log_offset: number;
};

export type WireCut = { at_offset: number; omitted_bytes: number; reason: string };
/** A system notice on the attempt, out of band from the log text. */
export type WireNotice = { at_offset: number; source: string; text: string };

export type ServerMessage =
  /** The subscription is live. `cursor` is where replay starts (events) or `offset` (log). */
  | { type: "subscribed"; id: string; topic: string; cursor?: number; offset?: number }
  | { type: "event"; id: string; event: WireEvent }
  /** Redacted log text from `offset`, `bytes` long. `eof` follows the last chunk of a finished attempt. */
  | { type: "log"; id: string; offset: number; bytes: number; text: string; eof?: boolean }
  /** The full current set of steps and cuts; replace what you hold. */
  | { type: "steps"; id: string; steps: WireStep[]; cuts: WireCut[]; notices: WireNotice[] }
  /** Where the output cap removed bytes from the log (sent on a log subscription; replace what you hold). */
  | { type: "cuts"; id: string; cuts: WireCut[]; notices: WireNotice[] }
  | { type: "error"; id?: string; code: string; message: string };
