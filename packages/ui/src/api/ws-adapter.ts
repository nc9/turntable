import type {
  ConnectionStatus,
  Realtime,
  RealtimeMessage,
  SubscribeOptions,
  Topic,
} from "./realtime";

// TODO(#30): the server side is not built yet. This adapter fixes the client contract so the UI
// does not change when the endpoint lands:
//   - WebSocket at /api/ws with auth on upgrade (session cookie or token).
//   - Client frames: {op:"subscribe", topic, cursor?, offset?} and {op:"unsubscribe", topic}.
//   - Server frames: RealtimeMessage as JSON; log data as base64 in `data`.
//   - On reconnect, resubscribe every topic with the last seen cursor / next byte offset; the
//     server replays missed events, then goes live. The adapter drops duplicates by cursor.
//   - Slow clients are dropped by the server with a {type:"reset"} carrying a resume cursor.
//   - Fallback to SSE / long-poll through `events()` when WebSocket is blocked.

export function createWsRealtime(_url: string): Realtime {
  let status: ConnectionStatus = "offline";
  const listeners = new Set<(s: ConnectionStatus) => void>();
  return {
    subscribe(_topic: Topic, _options: SubscribeOptions, _handler: (m: RealtimeMessage) => void) {
      throw new Error("WebSocket realtime is not implemented yet (#30)");
    },
    status: () => status,
    onStatus(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
  };
}
