import type { Job, JobAttempt, Run, StepEvent } from "./types";

/** What a client may subscribe to. The server checks each topic against the caller's scope (#30). */
export type Topic =
  | { kind: "org"; orgId: string }
  | { kind: "project"; projectId: string }
  | { kind: "run"; runId: string }
  | { kind: "attempt-log"; attemptId: string };

export const topicKey = (t: Topic): string => {
  switch (t.kind) {
    case "org":
      return `org:${t.orgId}`;
    case "project":
      return `project:${t.projectId}`;
    case "run":
      return `run:${t.runId}`;
    case "attempt-log":
      return `log:${t.attemptId}`;
  }
};

/** A row-level change from the event feed. `cursor` is monotonic and opaque to the client. */
export type ChangeEvent =
  | { type: "change"; cursor: string; entity: "run"; op: "upsert"; value: Run }
  | { type: "change"; cursor: string; entity: "job"; op: "upsert"; value: Job }
  | { type: "change"; cursor: string; entity: "attempt"; op: "upsert"; value: JobAttempt };

/** Ordered log bytes. `offset` is the byte position of `data[0]`; chunks may split lines and UTF-8. */
export type LogChunkEvent = {
  type: "log";
  attemptId: string;
  offset: number;
  data: Uint8Array;
  /** Set on the last chunk of a finished attempt. */
  eof?: boolean;
};

/** A step boundary for an attempt, out of band from the log bytes. */
export type StepMessage = { type: "step" } & StepEvent;

export type RealtimeMessage =
  | ChangeEvent
  /** The server cannot replay from the cursor (or dropped a slow client); refetch, then resume. */
  | { type: "reset"; topic: string; cursor: string }
  | LogChunkEvent
  | StepMessage;

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "offline";

export type SubscribeOptions = {
  /** Resume change events after this cursor. Omit for live-only. */
  cursor?: string;
  /** For attempt-log topics: resume from this byte offset. */
  offset?: number;
};

export interface Realtime {
  /** Returns an unsubscribe function. Handlers run in order; the adapter dedupes across reconnects. */
  subscribe(
    topic: Topic,
    options: SubscribeOptions,
    handler: (msg: RealtimeMessage) => void,
  ): () => void;
  status(): ConnectionStatus;
  onStatus(listener: (s: ConnectionStatus) => void): () => void;
}
