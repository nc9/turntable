import {
  BEARER_PREFIX,
  CLOSE,
  SUBPROTOCOL,
  type ClientMessage,
  type ServerMessage,
  type WireCut,
} from "@longshore/core/realtime-protocol";
import type { LongshoreApi } from "./client";
import { createSnapshotSource } from "./polling-realtime";
import { stepEvents } from "./step-events";
import {
  type ConnectionStatus,
  type Realtime,
  type RealtimeMessage,
  type SubscribeOptions,
  type Topic,
} from "./realtime";

// Realtime over the server's WebSocket (`/api/v1/realtime`, see core/src/realtime/protocol.ts).
//
// The server pushes feed events, which say that something changed but are not whole entities, so
// an event topic refreshes the snapshot (the same fetch polling uses) and emits only the
// differences. Log bytes, steps and cuts are pushed as they are. The connection reconnects with
// backoff and resumes each topic from the last cursor or byte offset it saw. If a socket cannot
// be opened at all (blocked, or the server refuses), subscriptions run on the polling transport
// until a socket works again.

export type WsRealtimeOptions = {
  url: string;
  token: () => string | null;
  api: LongshoreApi;
  /** Used while the socket is unavailable. */
  fallback: Realtime;
  onUnauthenticated?: () => void;
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect backoff. */
  baseMs?: number;
  maxMs?: number;
  /** Failed connects in a row before falling back to polling. */
  fallbackAfter?: number;
  /** How long to wait before trying the socket again while on the polling fallback. */
  fallbackRetryMs?: number;
  /** Wait before refreshing a snapshot after a burst of events. */
  refreshDebounceMs?: number;
};

type Part = { id: string; topic: string };

type Sub = {
  key: number;
  topic: Topic;
  opts: SubscribeOptions;
  handler: (m: RealtimeMessage) => void;
  /** Server subscriptions this UI subscription maps onto. */
  parts: Part[];
  /** Last feed cursor seen (event topics). */
  cursor: number | null;
  /** Next log byte offset (log topics). */
  offset: number;
  refresh: (() => Promise<void>) | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  refreshing: boolean;
  again: boolean;
  fallbackOff: (() => void) | null;
  closed: boolean;
};

function serverTopics(t: Topic): string[] {
  switch (t.kind) {
    case "org":
      return ["org"];
    case "project":
      return [`project:${t.projectId}`];
    case "run":
      return [`run:${t.runId}`];
    case "attempt-log":
      return [`attempt:${t.attemptId}:log`, `attempt:${t.attemptId}:steps`];
  }
}

const enc = new TextEncoder();

const cutEvents = (attemptId: string, cuts: readonly WireCut[]): RealtimeMessage[] =>
  cuts.map((c) => ({
    type: "cut",
    attemptId,
    kind: "cut",
    atOffset: c.at_offset,
    omittedBytes: c.omitted_bytes,
    reason: c.reason,
  }));

export function createWsRealtime(options: WsRealtimeOptions): Realtime {
  const WS = options.WebSocketImpl ?? (typeof WebSocket === "undefined" ? undefined : WebSocket);
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 15_000;
  const fallbackAfter = options.fallbackAfter ?? 3;
  const debounce = options.refreshDebounceMs ?? 120;

  let status: ConnectionStatus = "connecting";
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  const setStatus = (s: ConnectionStatus) => {
    if (s === status) return;
    status = s;
    for (const l of statusListeners) l(s);
  };

  const subs = new Map<number, Sub>();
  const byServerId = new Map<string, Sub>();
  let nextKey = 1;
  let socket: WebSocket | null = null;
  let open = false;
  let failures = 0;
  let stopped = false;
  let syntheticCursor = 0;
  const nextCursor = () => String(++syntheticCursor).padStart(10, "0");

  const deliver = (sub: Sub, m: RealtimeMessage) => {
    if (!sub.closed) sub.handler(m);
  };

  // ---- snapshot refresh for event topics ----

  function scheduleRefresh(sub: Sub, immediate = false): void {
    if (!sub.refresh || sub.closed) return;
    if (sub.refreshing) {
      sub.again = true;
      return;
    }
    if (sub.refreshTimer) return;
    sub.refreshTimer = setTimeout(
      () => {
        sub.refreshTimer = null;
        void runRefresh(sub);
      },
      immediate ? 0 : debounce,
    );
  }

  async function runRefresh(sub: Sub): Promise<void> {
    if (!sub.refresh || sub.closed) return;
    sub.refreshing = true;
    try {
      await sub.refresh();
    } catch {
      // The next event or reconnect refreshes again; a 401 is handled by the API layer.
    } finally {
      sub.refreshing = false;
      if (sub.again) {
        sub.again = false;
        scheduleRefresh(sub);
      }
    }
  }

  // ---- socket ----

  function sendMsg(m: ClientMessage): void {
    if (socket && open) socket.send(JSON.stringify(m));
  }

  function subscribeOnSocket(sub: Sub): void {
    sub.parts = serverTopics(sub.topic).map((topic) => ({ id: `s${nextKey++}`, topic }));
    for (const p of sub.parts) {
      byServerId.set(p.id, sub);
      const isLog = p.topic.endsWith(":log");
      sendMsg({
        op: "subscribe",
        id: p.id,
        topic: p.topic,
        ...(isLog ? { from_offset: sub.offset } : {}),
        // Resume the feed after the last cursor seen; the first time, start from now (the
        // snapshot refresh below covers anything older).
        ...(!isLog && !p.topic.endsWith(":steps") && sub.cursor !== null
          ? { after: sub.cursor }
          : {}),
      });
    }
  }

  function dropServerSubs(sub: Sub): void {
    for (const p of sub.parts) {
      byServerId.delete(p.id);
      sendMsg({ op: "unsubscribe", id: p.id });
    }
    sub.parts = [];
  }

  function startFallback(sub: Sub): void {
    if (sub.fallbackOff || sub.closed) return;
    sub.fallbackOff = options.fallback.subscribe(
      sub.topic,
      { ...sub.opts, offset: sub.offset },
      (m) => {
        if (m.type === "log") sub.offset = Math.max(sub.offset, m.offset + m.data.length);
        deliver(sub, m);
      },
    );
  }

  function stopFallback(sub: Sub): void {
    sub.fallbackOff?.();
    sub.fallbackOff = null;
  }

  function onMessage(raw: string): void {
    let m: ServerMessage;
    try {
      m = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    const id = "id" in m ? m.id : undefined;
    const sub = id !== undefined ? byServerId.get(id) : undefined;
    if (!sub) return;
    switch (m.type) {
      case "subscribed":
        if (m.cursor !== undefined && sub.cursor === null) sub.cursor = m.cursor;
        // Anything that changed before the subscription went live is picked up by a refresh.
        if (sub.refresh) scheduleRefresh(sub, true);
        return;
      case "event":
        if (sub.cursor !== null && m.event.cursor <= sub.cursor) return; // replayed
        sub.cursor = m.event.cursor;
        scheduleRefresh(sub);
        return;
      case "log": {
        if (m.offset < sub.offset) return; // already have these bytes
        // Keep byte offsets exact: the text should re-encode to `bytes`; pad or trim if not.
        let data = enc.encode(m.text);
        if (data.length !== m.bytes) {
          const fixed = new Uint8Array(m.bytes).fill(0x20);
          fixed.set(data.subarray(0, m.bytes));
          data = fixed;
        }
        sub.offset = m.offset + data.length;
        const attemptId = sub.topic.kind === "attempt-log" ? sub.topic.attemptId : "";
        deliver(sub, {
          type: "log",
          attemptId,
          offset: m.offset,
          data,
          ...(m.eof ? { eof: true } : {}),
        });
        return;
      }
      case "steps": {
        const attemptId = sub.topic.kind === "attempt-log" ? sub.topic.attemptId : "";
        for (const e of stepEvents(attemptId, m.steps)) deliver(sub, e);
        for (const e of cutEvents(attemptId, m.cuts)) deliver(sub, e);
        return;
      }
      case "cuts": {
        const attemptId = sub.topic.kind === "attempt-log" ? sub.topic.attemptId : "";
        for (const e of cutEvents(attemptId, m.cuts)) deliver(sub, e);
        return;
      }
      case "error":
        // The server will not stream this topic (not found, limit): poll it instead.
        if (m.code !== "internal") {
          dropServerSubs(sub);
          startFallback(sub);
        }
        return;
    }
  }

  function connect(): void {
    if (stopped || socket || !WS) return;
    const token = options.token();
    if (!token) return;
    setStatus(failures > 0 ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      ws = new WS(options.url, [SUBPROTOCOL, `${BEARER_PREFIX}${token}`]);
    } catch {
      onClosed(1006);
      return;
    }
    socket = ws;
    ws.onopen = () => {
      open = true;
      failures = 0;
      setStatus("live");
      for (const sub of subs.values()) {
        stopFallback(sub);
        subscribeOnSocket(sub);
      }
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") onMessage(e.data);
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (socket !== ws) return;
      onClosed(e.code);
    };
  }

  function onClosed(code: number): void {
    const wasOpen = open;
    socket = null;
    open = false;
    byServerId.clear();
    for (const sub of subs.values()) sub.parts = [];
    if (stopped) return;
    if (code === CLOSE.unauthenticated) {
      setStatus("offline");
      options.onUnauthenticated?.();
      return; // do not retry with a rejected token
    }
    if (!wasOpen) failures++;
    // A socket that cannot be opened: run on polling, and keep trying in the background.
    const useFallback = failures >= fallbackAfter || code === CLOSE.limit;
    if (useFallback) {
      for (const sub of subs.values()) startFallback(sub);
      setStatus("polling");
    } else {
      setStatus("reconnecting");
    }
    if (subs.size === 0) return; // nothing to stream; the next subscribe reconnects
    // A slow-client drop resumes at once; anything else backs off with jitter.
    const exp = Math.min(maxMs, baseMs * 2 ** Math.min(failures, 10));
    const delay =
      code === CLOSE.slowClient
        ? 0
        : useFallback
          ? (options.fallbackRetryMs ?? 10_000)
          : exp * (0.5 + Math.random() / 2);
    setTimeout(() => {
      connect();
    }, delay);
  }

  return {
    subscribe(topic, opts, handler) {
      const sub: Sub = {
        key: nextKey++,
        topic,
        opts,
        handler,
        parts: [],
        cursor: null,
        offset: opts.offset ?? 0,
        refresh: null,
        refreshTimer: null,
        refreshing: false,
        again: false,
        fallbackOff: null,
        closed: false,
      };
      if (topic.kind !== "attempt-log") {
        sub.refresh = createSnapshotSource(
          options.api,
          topic,
          (m) => deliver(sub, m),
          nextCursor,
        ).refresh;
      }
      subs.set(sub.key, sub);
      if (!WS) startFallback(sub);
      else if (open) subscribeOnSocket(sub);
      else if (failures >= fallbackAfter) startFallback(sub);
      else connect();
      // Event topics load their snapshot straight away; later refreshes follow the feed.
      if (sub.refresh && !open) scheduleRefresh(sub, true);
      return () => {
        sub.closed = true;
        if (sub.refreshTimer) clearTimeout(sub.refreshTimer);
        dropServerSubs(sub);
        stopFallback(sub);
        subs.delete(sub.key);
      };
    },
    status: () => status,
    onStatus(l) {
      statusListeners.add(l);
      l(status);
      return () => statusListeners.delete(l);
    },
  };
}
