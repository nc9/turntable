// Server-sent events for the event feed (#25): `GET /api/v1/events/stream`. It adds no access
// rules of its own. Authentication and scope come from dispatching the `events` operation as the
// caller, exactly like the REST route and the realtime socket, so a token that cannot read an
// event over REST cannot stream it either.
//
// Resume: every frame's `id` is the event's cursor. A client that reconnects with `Last-Event-ID`
// (browsers do it themselves) or `?after=` gets the events after that cursor, so nothing is lost
// or repeated. A slow reader whose unread bytes pass the cap is closed and resumes the same way.
import { onEventsAppended } from "../db/repos";
import { API_HEADERS } from "../ops/rest";
import { type DispatchEnv, dispatch, resolveCallerScope } from "../ops/dispatch";
import { OpError, errorBody } from "../ops/errors";

export const SSE_PATH = "/api/v1/events/stream";

export type SseLimits = {
  /** Unread bytes a connection may hold before it is closed as a slow client. */
  maxBufferedBytes: number;
  heartbeatMs: number;
  /** How often the token is checked again, so a revoked one ends the stream. */
  reauthMs: number;
  /** Safety poll for an event another process appended (the in-process wake cannot see it). */
  pollMs: number;
  maxConnectionsPerOrg: number;
  maxConnections: number;
  /** Events per read. */
  page: number;
};

export const DEFAULT_SSE_LIMITS: SseLimits = {
  maxBufferedBytes: 1024 * 1024,
  heartbeatMs: 15_000,
  reauthMs: 30_000,
  pollMs: 5_000,
  maxConnectionsPerOrg: 25,
  maxConnections: 500,
  page: 100,
};

type WireEvent = { cursor: number; type: string } & Record<string, unknown>;
type EventsOut = { events: WireEvent[]; next_after: number };

const enc = new TextEncoder();

const frame = (ev: WireEvent): Uint8Array =>
  enc.encode(`id: ${ev.cursor}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);

function fail(err: OpError): Response {
  return new Response(JSON.stringify(errorBody(err)), {
    status: err.status,
    headers: {
      ...API_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...(err.code === "unauthenticated" ? { "www-authenticate": 'Bearer realm="longshore"' } : {}),
    },
  });
}

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

export type EventStream = {
  handle(
    req: Request,
    srv?: { timeout(req: Request, seconds: number): void },
  ): Promise<Response | undefined>;
  /** Open streams, for tests and status. */
  readonly open: number;
};

export function createEventStream(o: {
  env: DispatchEnv;
  allowedOrigins?: readonly string[];
  limits?: Partial<SseLimits>;
}): EventStream {
  const limits: SseLimits = { ...DEFAULT_SSE_LIMITS, ...o.limits };
  const byOrg = new Map<string, number>();
  let total = 0;

  return {
    get open() {
      return total;
    },
    async handle(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== SSE_PATH) return undefined;
      if (req.method !== "GET") {
        return fail(new OpError("method_not_allowed", "method not allowed"));
      }
      if (!originAllowed(req, o.allowedOrigins ?? [])) {
        return fail(new OpError("forbidden", "origin not allowed"));
      }
      const bearer = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization") ?? "");
      if (!bearer) return fail(new OpError("unauthenticated", "missing bearer token"));
      const cred = { kind: "bearer" as const, token: bearer[1]! };

      // The cursor: Last-Event-ID (a reconnect) wins over ?after=; default is the tip.
      const last = req.headers.get("last-event-id");
      const rawAfter = last && /^\d+$/.test(last) ? last : url.searchParams.get("after");
      const start: number | "now" =
        rawAfter === null || rawAfter === "now"
          ? "now"
          : /^\d+$/.test(rawAfter)
            ? Number(rawAfter)
            : (undefined as never);
      if (start === undefined) {
        return fail(new OpError("invalid_input", "after must be an event cursor or `now`"));
      }
      const filters: Record<string, unknown> = {};
      const types = url.searchParams.get("types");
      if (types !== null) filters.types = types === "" ? [] : types.split(",");
      const project = url.searchParams.get("project");
      if (project !== null) filters.project = project;

      const read = async (after: number | "now", limit: number): Promise<EventsOut> => {
        const r = await dispatch(o.env, cred, "events", { after, limit, ...filters });
        if (!r.ok) throw r.error;
        return r.output as EventsOut;
      };

      // The first read happens before the response, so a bad token, a bad filter or an unknown
      // project is a normal HTTP error, not a stream that opens and closes.
      let first: EventsOut;
      let orgId: string;
      try {
        first = await read(start, limits.page);
        orgId = (await resolveCallerScope(o.env, cred)).scope.orgId;
      } catch (err) {
        if (err instanceof OpError) return fail(err);
        console.error("longshore: SSE error", err);
        return fail(new OpError("internal", "internal error"));
      }
      if (
        total >= limits.maxConnections ||
        (byOrg.get(orgId) ?? 0) >= limits.maxConnectionsPerOrg
      ) {
        return fail(new OpError("unavailable", "too many open event streams"));
      }
      total++;
      byOrg.set(orgId, (byOrg.get(orgId) ?? 0) + 1);
      srv?.timeout(req, 0); // heartbeats keep it alive; the server's idle timeout must not cut it

      let cursor = start === "now" ? first.next_after : start;
      let closed = false;
      let pumping = false;
      let dirty = false;
      const timers: ReturnType<typeof setInterval>[] = [];
      let off: (() => void) | undefined;
      let controller!: ReadableStreamDefaultController<Uint8Array>;

      const close = (finalFrame?: string): void => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        off?.();
        total--;
        const n = (byOrg.get(orgId) ?? 1) - 1;
        if (n <= 0) byOrg.delete(orgId);
        else byOrg.set(orgId, n);
        try {
          if (finalFrame) controller.enqueue(enc.encode(finalFrame));
          controller.close();
        } catch {
          // already closed by the reader
        }
      };

      /** False when the reader is too far behind: the stream is closed and the caller stops. */
      const write = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          close(
            `event: error\ndata: {"code":"slow_client","message":"resume from your last id"}\n\n`,
          );
          return false;
        }
        controller.enqueue(chunk);
        return true;
      };

      const send = (events: WireEvent[]): boolean => {
        for (const ev of events) if (!write(frame(ev))) return false;
        return true;
      };

      const pump = async (): Promise<void> => {
        if (pumping) {
          dirty = true;
          return;
        }
        pumping = true;
        try {
          do {
            dirty = false;
            for (;;) {
              if (closed) return;
              const out = await read(cursor, limits.page);
              if (!send(out.events)) return;
              cursor = Math.max(cursor, out.next_after);
              if (out.events.length < limits.page) break;
            }
          } while (dirty);
        } catch (err) {
          if (err instanceof OpError) {
            close(
              `event: error\ndata: ${JSON.stringify({ code: err.code, message: err.message })}\n\n`,
            );
          } else {
            console.error("longshore: SSE error", err);
            close(`event: error\ndata: {"code":"internal","message":"internal error"}\n\n`);
          }
        } finally {
          pumping = false;
        }
      };

      const stream = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c;
            c.enqueue(enc.encode(`retry: 3000\n: connected\n\n`));
            // What the first read returned, then everything after it.
            if (send(first.events)) {
              if (first.events.length > 0) cursor = Math.max(cursor, first.next_after);
              off = onEventsAppended((org) => {
                if (org === orgId) void pump();
              });
              timers.push(
                setInterval(() => void write(enc.encode(`: hb\n\n`)), limits.heartbeatMs),
                setInterval(() => void pump(), limits.pollMs),
                setInterval(() => {
                  void dispatch(o.env, cred, "whoami", {}).then((r) => {
                    if (!r.ok) {
                      close(
                        `event: error\ndata: ${JSON.stringify({ code: r.error.code, message: "token no longer valid" })}\n\n`,
                      );
                    }
                  });
                }, limits.reauthMs),
              );
              void pump();
            }
          },
          cancel() {
            close();
          },
        },
        { highWaterMark: limits.maxBufferedBytes, size: (c) => c?.byteLength ?? 0 },
      );
      req.signal.addEventListener("abort", () => close(), { once: true });
      return new Response(stream, {
        headers: {
          ...API_HEADERS,
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        },
      });
    },
  };
}
