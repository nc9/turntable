/* oxlint-disable unicorn/no-useless-spread -- sockets and subscriptions are removed while iterating, so copy first */
// Realtime WebSocket server (#30). It adds no access rules of its own: authentication and scope
// come from the operations dispatcher, and every piece of data is read by dispatching the same
// read operation a REST caller would use (events, get_run, job_log, job_steps, job_cuts), as the
// connection's token. A token that cannot read something over REST cannot subscribe to it either.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { getAttempt, latestEventId, onEventsAppended, onLogAppended } from "../db/repos";
import { type DispatchEnv, authenticate, dispatch, resolveCallerScope } from "../ops/dispatch";
import { OpError } from "../ops/errors";
import {
  BEARER_PREFIX,
  CLOSE,
  MAX_MESSAGE_BYTES,
  REALTIME_PATH,
  SUBPROTOCOL,
  type ClientMessage,
  type ServerMessage,
  type Topic,
  type WireCut,
  type WireNotice,
  type WireEvent,
  type WireStep,
  parseClientMessage,
  parseTopic,
} from "./protocol";

export type Limits = {
  maxConnectionsPerOrg: number;
  maxSubscriptionsPerConnection: number;
  maxSubscriptionsPerOrg: number;
  /** Unsent bytes a connection may hold before it is dropped as a slow client. */
  maxBufferedBytes: number;
  /** A connection with no subscriptions this long is closed. */
  idleNoSubscriptionMs: number;
  /** How often connections are re-authenticated and idle-checked. */
  sweepMs: number;
  /**
   * Safety-net interval for a live log tail. Appends wake a tail at once (onLogAppended); this
   * only catches an append made by another process, which the in-process notifier cannot see.
   */
  logPollMs: number;
  /** Events per read while replaying. */
  eventPage: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxConnectionsPerOrg: 50,
  maxSubscriptionsPerConnection: 32,
  maxSubscriptionsPerOrg: 500,
  maxBufferedBytes: 1024 * 1024,
  idleNoSubscriptionMs: 2 * 60_000,
  sweepMs: 30_000,
  logPollMs: 5_000,
  eventPage: 100,
};

export type RealtimeOptions = {
  env: DispatchEnv;
  /** Origins besides the page's own that may open a socket (a browser sends Origin). */
  allowedOrigins?: readonly string[];
  limits?: Partial<Limits>;
};

type Sub = {
  id: string;
  topic: Topic;
  /** Event topics: last cursor sent. */
  cursor: number;
  /** Log topic: next byte offset. */
  offset: number;
  jobId: string;
  attemptNo: number;
  attemptId: string;
  /** Event topics narrowed to one run. */
  runId: string | null;
  projectSlug: string | null;
  /** Set once the ack is sent; nothing is delivered before it. */
  ready: boolean;
  pumping: boolean;
  dirty: boolean;
  stepsPumping: boolean;
  stepsDirty: boolean;
  done: boolean;
  /** Signature of the last steps/cuts sent, to send only changes. */
  sig: string;
  timer: ReturnType<typeof setInterval> | null;
};

export type WsData = {
  token: string;
  orgId: string;
  subs: Map<string, Sub>;
  closed: boolean;
  /** True once `open` ran, i.e. the pending slot became a real one. */
  opened: boolean;
  noSubsSince: number;
};

type Ws = ServerWebSocket<WsData>;

const LOG_PAGE_BYTES = 262_144;

function originAllowed(req: Request, allow: readonly string[]): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true; // not a browser: the bearer token is the credential
  if (allow.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

/** Reads the offered subprotocols: returns the bearer token if `longshore.v1` is offered too. */
function tokenFromProtocols(header: string | null): string | null {
  if (!header) return null;
  const offered = header.split(",").map((p) => p.trim());
  if (!offered.includes(SUBPROTOCOL)) return null;
  const bearer = offered.find((p) => p.startsWith(BEARER_PREFIX));
  return bearer ? bearer.slice(BEARER_PREFIX.length) : null;
}

export function createRealtime(options: RealtimeOptions) {
  const env = options.env;
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const allowed = options.allowedOrigins ?? [];
  const byOrg = new Map<string, Set<Ws>>();
  const subCount = new Map<string, number>();
  /** Upgrades accepted but not yet open, per org: they hold a slot so the cap cannot be raced. */
  const pending = new Map<string, number>();
  const hold = (orgId: string) => pending.set(orgId, (pending.get(orgId) ?? 0) + 1);
  const release = (orgId: string) => {
    const n = (pending.get(orgId) ?? 1) - 1;
    if (n <= 0) pending.delete(orgId);
    else pending.set(orgId, n);
  };
  const connectionsFor = (orgId: string) =>
    (byOrg.get(orgId)?.size ?? 0) + (pending.get(orgId) ?? 0);

  const cred = (ws: Ws) => ({ kind: "bearer" as const, token: ws.data.token });

  function send(ws: Ws, msg: ServerMessage): boolean {
    if (ws.data.closed) return false;
    const r = ws.send(JSON.stringify(msg));
    // 0 means the frame was dropped; otherwise bound what the peer has not read yet.
    if (r === 0 || ws.getBufferedAmount() > limits.maxBufferedBytes) {
      closeWith(ws, CLOSE.slowClient, `slow client; resume from your last cursors`);
      return false;
    }
    return true;
  }

  function closeWith(ws: Ws, code: number, reason: string): void {
    if (ws.data.closed) return;
    ws.data.closed = true;
    cleanup(ws);
    ws.close(code, reason.slice(0, 120));
  }

  function removeSub(ws: Ws, sub: Sub): void {
    if (sub.timer) clearInterval(sub.timer);
    sub.done = true;
    if (ws.data.subs.delete(sub.id)) {
      const n = (subCount.get(ws.data.orgId) ?? 1) - 1;
      if (n <= 0) subCount.delete(ws.data.orgId);
      else subCount.set(ws.data.orgId, n);
    }
    if (ws.data.subs.size === 0) ws.data.noSubsSince = Date.now();
  }

  function cleanup(ws: Ws): void {
    for (const sub of [...ws.data.subs.values()]) removeSub(ws, sub);
    const set = byOrg.get(ws.data.orgId);
    set?.delete(ws);
    if (set && set.size === 0) byOrg.delete(ws.data.orgId);
  }

  /** Reports a failure to the client; a rejected token ends the connection. */
  function fail(ws: Ws, id: string | undefined, err: unknown): void {
    if (err instanceof OpError) {
      if (err.code === "unauthenticated")
        return closeWith(ws, CLOSE.unauthenticated, "token no longer valid");
      send(ws, { type: "error", ...(id ? { id } : {}), code: err.code, message: err.message });
      return;
    }
    console.error("longshore: realtime error", err);
    send(ws, { type: "error", ...(id ? { id } : {}), code: "internal", message: "internal error" });
  }

  async function op<T>(ws: Ws, name: string, input: Record<string, unknown>): Promise<T> {
    const r = await dispatch(env, cred(ws), name, input);
    if (!r.ok) throw r.error;
    return r.output as T;
  }

  // ---- event topics ----

  type EventsOut = { events: WireEvent[]; next_after: number };

  async function readEvents(ws: Ws, sub: Sub, limit: number): Promise<EventsOut> {
    return op<EventsOut>(ws, "events", {
      after: sub.cursor,
      limit,
      ...(sub.projectSlug ? { project: sub.projectSlug } : {}),
    });
  }

  async function pumpEvents(ws: Ws, sub: Sub): Promise<void> {
    if (sub.pumping) {
      sub.dirty = true;
      return;
    }
    sub.pumping = true;
    try {
      do {
        sub.dirty = false;
        for (;;) {
          if (sub.done || ws.data.closed) return;
          const out = await readEvents(ws, sub, limits.eventPage);
          for (const ev of out.events) {
            if (sub.runId === null || ev.run_id === sub.runId) {
              if (!send(ws, { type: "event", id: sub.id, event: ev })) return;
            }
          }
          // Advance past filtered events too, so the cursor tracks the feed, not the filter.
          sub.cursor = Math.max(sub.cursor, out.next_after);
          if (out.events.length < limits.eventPage) break;
        }
      } while (sub.dirty);
    } catch (err) {
      removeSub(ws, sub);
      fail(ws, sub.id, err);
    } finally {
      sub.pumping = false;
    }
  }

  // ---- attempt topics ----

  async function pumpSteps(ws: Ws, sub: Sub): Promise<void> {
    if (sub.stepsPumping) {
      sub.stepsDirty = true;
      return;
    }
    sub.stepsPumping = true;
    try {
      do {
        sub.stepsDirty = false;
        if (sub.done || ws.data.closed) return;
        const [steps, cuts] = await Promise.all([
          op<{ steps: WireStep[] }>(ws, "job_steps", { job_id: sub.jobId, attempt: sub.attemptNo }),
          op<{ cuts: WireCut[]; notices: WireNotice[] }>(ws, "job_cuts", {
            job_id: sub.jobId,
            attempt: sub.attemptNo,
          }),
        ]);
        const sig = JSON.stringify([steps.steps, cuts.cuts, cuts.notices]);
        if (sig !== sub.sig) {
          sub.sig = sig;
          if (sub.topic.kind === "attempt-steps") {
            if (
              !send(ws, {
                type: "steps",
                id: sub.id,
                steps: steps.steps,
                cuts: cuts.cuts,
                notices: cuts.notices,
              })
            )
              return;
          } else if (
            !send(ws, { type: "cuts", id: sub.id, cuts: cuts.cuts, notices: cuts.notices })
          )
            return;
        }
      } while (sub.stepsDirty);
    } catch (err) {
      removeSub(ws, sub);
      fail(ws, sub.id, err);
    } finally {
      sub.stepsPumping = false;
    }
  }

  const TERMINAL = new Set(["success", "failure", "infra_error", "cancelled", "skipped"]);

  async function pumpLog(ws: Ws, sub: Sub): Promise<void> {
    if (sub.pumping) {
      sub.dirty = true;
      return;
    }
    sub.pumping = true;
    try {
      do {
        sub.dirty = false;
        for (;;) {
          if (sub.done || ws.data.closed) return;
          const out = await op<{
            text: string;
            offset: number;
            bytes: number;
            total_bytes: number;
            next_offset: number | null;
          }>(ws, "job_log", {
            job_id: sub.jobId,
            attempt: sub.attemptNo,
            mode: "range",
            offset: sub.offset,
            max_bytes: LOG_PAGE_BYTES,
          });
          if (out.bytes > 0) {
            if (
              !send(ws, {
                type: "log",
                id: sub.id,
                offset: out.offset,
                bytes: out.bytes,
                text: out.text,
              })
            )
              return;
          }
          sub.offset = out.next_offset ?? out.offset + out.bytes;
          if (out.next_offset === null || out.bytes === 0) {
            // Caught up. If the attempt is over and nothing more can arrive, say so once.
            const { scope } = await resolveCallerScope(env, cred(ws));
            const attempt = await getAttempt(env.db, scope, sub.attemptId);
            if (attempt && TERMINAL.has(attempt.state) && sub.offset >= out.total_bytes) {
              // Re-read once so a chunk appended between the read and the state check is not lost.
              if (sub.dirty) break;
              send(ws, {
                type: "log",
                id: sub.id,
                offset: sub.offset,
                bytes: 0,
                text: "",
                eof: true,
              });
              removeSub(ws, sub);
              return;
            }
            break;
          }
        }
      } while (sub.dirty);
    } catch (err) {
      removeSub(ws, sub);
      fail(ws, sub.id, err);
    } finally {
      sub.pumping = false;
    }
    // Cuts ride along with the log; sent after the bytes, and again whenever they change.
    if (!sub.done) await pumpSteps(ws, sub);
  }

  function pump(ws: Ws, sub: Sub): void {
    if (!sub.ready || sub.done) return;
    switch (sub.topic.kind) {
      case "org":
      case "project":
      case "run":
        void pumpEvents(ws, sub);
        return;
      case "attempt-log":
        void pumpLog(ws, sub);
        return;
      case "attempt-steps":
        void pumpSteps(ws, sub);
        return;
    }
  }

  // ---- subscribe ----

  async function subscribe(ws: Ws, m: Extract<ClientMessage, { op: "subscribe" }>): Promise<void> {
    const reject = (code: string, message: string) =>
      send(ws, { type: "error", id: m.id, code, message });
    if (ws.data.subs.has(m.id))
      return void reject("invalid_input", "subscription id already in use");
    if (ws.data.subs.size >= limits.maxSubscriptionsPerConnection) {
      return void reject("limit", "too many subscriptions on this connection");
    }
    if ((subCount.get(ws.data.orgId) ?? 0) >= limits.maxSubscriptionsPerOrg) {
      return void reject("limit", "too many subscriptions for this org");
    }
    const topic = parseTopic(m.topic);
    if (!topic) return void reject("invalid_input", "unknown topic");

    const sub: Sub = {
      id: m.id,
      topic,
      cursor: 0,
      offset: m.from_offset ?? 0,
      jobId: "",
      attemptNo: 0,
      attemptId: "",
      runId: null,
      projectSlug: topic.kind === "project" ? topic.slug : null,
      ready: false,
      pumping: false,
      dirty: false,
      stepsPumping: false,
      stepsDirty: false,
      done: false,
      sig: "",
      timer: null,
    };
    // Reserve the id and the slot before any await, so a duplicate or a flood cannot slip past.
    ws.data.subs.set(sub.id, sub);
    subCount.set(ws.data.orgId, (subCount.get(ws.data.orgId) ?? 0) + 1);

    try {
      // Scope: the caller's grant, narrowed to the project if the topic names one.
      const { scope } = await resolveCallerScope(
        env,
        cred(ws),
        sub.projectSlug ? { project: sub.projectSlug } : {},
      );

      if (topic.kind === "run") {
        // get_run is the authorization (existence in scope, role); the data is the event feed.
        await op(ws, "get_run", { run_id: topic.id });
        sub.runId = topic.id;
      }
      if (topic.kind === "attempt-log" || topic.kind === "attempt-steps") {
        const attempt = await getAttempt(env.db, scope, topic.id);
        if (!attempt) throw new OpError("not_found", "attempt not found");
        sub.attemptId = attempt.id;
        sub.jobId = attempt.jobId;
        sub.attemptNo = attempt.attempt;
        // Authorize by reading what the topic would stream (role, scope, caps live in the ops).
        await op(ws, topic.kind === "attempt-log" ? "job_log" : "job_steps", {
          job_id: sub.jobId,
          attempt: sub.attemptNo,
          ...(topic.kind === "attempt-log"
            ? { mode: "range", offset: sub.offset, max_bytes: 1 }
            : {}),
        });
      } else {
        sub.cursor = m.after ?? (await latestEventId(env.db, scope));
        // First read doubles as the role check for the events operation.
        await readEvents(ws, sub, 1);
      }
    } catch (err) {
      removeSub(ws, sub);
      return fail(ws, m.id, err);
    }
    if (ws.data.closed || sub.done) return;

    const ack: ServerMessage =
      topic.kind === "attempt-log"
        ? { type: "subscribed", id: sub.id, topic: m.topic, offset: sub.offset }
        : topic.kind === "attempt-steps"
          ? { type: "subscribed", id: sub.id, topic: m.topic }
          : { type: "subscribed", id: sub.id, topic: m.topic, cursor: sub.cursor };
    if (!send(ws, ack)) return;
    sub.ready = true;
    // Wake-ups were already routed to this subscription from the moment it was registered
    // above, so an event committed during setup marks it dirty and is read, not missed.
    if (topic.kind === "attempt-log") {
      sub.timer = setInterval(() => void pumpLog(ws, sub), limits.logPollMs);
    }
    pump(ws, sub);
  }

  // ---- server plumbing ----

  const stopListening = onEventsAppended((orgId) => {
    const conns = byOrg.get(orgId);
    if (!conns) return;
    for (const ws of conns) for (const sub of ws.data.subs.values()) pump(ws, sub);
  });

  // A committed log chunk wakes only the tails of that attempt.
  const stopLogListening = onLogAppended((orgId, attemptId) => {
    const conns = byOrg.get(orgId);
    if (!conns) return;
    for (const ws of conns)
      for (const sub of ws.data.subs.values())
        if (sub.topic.kind === "attempt-log" && sub.attemptId === attemptId) pump(ws, sub);
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const conns of [...byOrg.values()]) {
      for (const ws of [...conns]) {
        if (ws.data.subs.size === 0 && now - ws.data.noSubsSince > limits.idleNoSubscriptionMs) {
          closeWith(ws, CLOSE.idle, "idle");
          continue;
        }
        // A revoked or expired token ends the connection without waiting for the next event.
        authenticate(env, cred(ws)).catch((err: unknown) => {
          if (err instanceof OpError && err.code === "unauthenticated") {
            closeWith(ws, CLOSE.unauthenticated, "token no longer valid");
          }
        });
      }
    }
  }, limits.sweepMs);
  sweeper.unref?.();

  const websocket: WebSocketHandler<WsData> = {
    maxPayloadLength: MAX_MESSAGE_BYTES * 4,
    idleTimeout: 120,
    sendPings: true,
    backpressureLimit: limits.maxBufferedBytes * 4,
    closeOnBackpressureLimit: false,
    open(ws) {
      // The slot reserved at upgrade becomes a real one; re-check, and never exceed the cap.
      ws.data.opened = true;
      release(ws.data.orgId);
      if ((byOrg.get(ws.data.orgId)?.size ?? 0) >= limits.maxConnectionsPerOrg) {
        ws.data.closed = true;
        ws.close(CLOSE.limit, "too many realtime connections for this org");
        return;
      }
      let set = byOrg.get(ws.data.orgId);
      if (!set) byOrg.set(ws.data.orgId, (set = new Set()));
      set.add(ws);
      ws.data.noSubsSince = Date.now();
    },
    message(ws, raw) {
      if (typeof raw !== "string") return closeWith(ws, CLOSE.protocol, "text frames only");
      const m = parseClientMessage(raw);
      if (!m) return closeWith(ws, CLOSE.protocol, "malformed message");
      if (m.op === "unsubscribe") {
        const sub = ws.data.subs.get(m.id);
        if (sub) removeSub(ws, sub);
        return;
      }
      void subscribe(ws, m);
    },
    close(ws) {
      ws.data.closed = true;
      if (!ws.data.opened) release(ws.data.orgId); // dropped between upgrade and open
      cleanup(ws);
    },
  };

  /**
   * Handles a request for the realtime path. Returns "upgraded" once the socket is open, a
   * Response to send (a refusal), or undefined for any other path.
   */
  async function handle(
    req: Request,
    server: Server<WsData>,
  ): Promise<Response | "upgraded" | undefined> {
    const url = new URL(req.url);
    if (url.pathname !== REALTIME_PATH) return undefined;
    const refuse = (status: number, message: string, extra: Record<string, string> = {}) =>
      new Response(message, { status, headers: { "cache-control": "no-store", ...extra } });

    if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return refuse(426, "this endpoint speaks WebSocket", { upgrade: "websocket" });
    }
    // A token in the URL would end up in logs and history. Refuse it outright.
    if (url.search !== "") return refuse(400, "no query string: send the token as a subprotocol");
    if (!originAllowed(req, allowed)) return refuse(403, "origin not allowed");
    const token = tokenFromProtocols(req.headers.get("sec-websocket-protocol"));
    if (token === null) {
      return refuse(401, "offer subprotocols longshore.v1 and bearer.<token>", {
        "www-authenticate": 'Bearer realm="longshore"',
      });
    }
    let orgId: string;
    try {
      const principal = await authenticate(env, { kind: "bearer", token });
      orgId = principal.orgId;
    } catch {
      return refuse(401, "invalid, expired or revoked token", {
        "www-authenticate": 'Bearer realm="longshore"',
      });
    }
    // Check and reserve with no await in between, so concurrent upgrades cannot all pass.
    if (connectionsFor(orgId) >= limits.maxConnectionsPerOrg) {
      return refuse(429, "too many realtime connections for this org", { "retry-after": "5" });
    }
    hold(orgId);
    let ok = false;
    try {
      ok = server.upgrade(req, {
        // Echo only the protocol name, never the token.
        headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL },
        data: {
          token,
          orgId,
          subs: new Map(),
          closed: false,
          opened: false,
          noSubsSince: Date.now(),
        } satisfies WsData,
      });
    } finally {
      if (!ok) release(orgId);
    }
    return ok ? "upgraded" : refuse(400, "websocket upgrade failed");
  }

  return {
    handle,
    websocket,
    limits,
    stats: () => ({
      connections: [...byOrg.values()].reduce((n, s) => n + s.size, 0),
      subscriptions: [...subCount.values()].reduce((n, c) => n + c, 0),
    }),
    stop() {
      stopListening();
      stopLogListening();
      clearInterval(sweeper);
      for (const conns of [...byOrg.values()])
        for (const ws of [...conns]) closeWith(ws, 1001, "server stopping");
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
