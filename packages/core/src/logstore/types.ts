// The log store (#717): where a job attempt's log bytes live. The main database keeps only
// metadata (cuts, notices, incomplete flags). `db` stores chunks in `log_chunks` (the default, one
// binary); `clickhouse` stores them in a ClickHouse service over its HTTP interface.

/** Whose log: every call is scoped by org, project and attempt, never by attempt alone. */
export type LogKey = { orgId: string; projectId: string; attemptId: string };

export type LogChunk = { offset: number; bytes: Buffer };

export type LogGrepQuery = {
  pattern: string;
  /** `pattern` is a regular expression (RE2 on ClickHouse, a safe subset on the db backend). */
  regex: boolean;
  ignoreCase: boolean;
  /** Cursor: only chunks starting at or after this offset are looked at. */
  from: number;
  /** Most matching chunks to return. */
  limit: number;
};

export type LogGrepResult = {
  /** Offsets of the chunks that contain a match, in order. */
  hits: number[];
  /** Where to continue (pass as `from`), or null when the scan reached the end of the log. */
  next: number | null;
};

export interface LogStore {
  readonly kind: "db" | "clickhouse";
  /** Stores a chunk at a byte offset. A second write at the same offset is ignored. */
  append(key: LogKey, offset: number, bytes: Uint8Array): Promise<void>;
  /** Chunks with offset >= `fromOffset`, in order. */
  read(key: LogKey, fromOffset?: number): Promise<LogChunk[]>;
  /** Bytes `[from, to)`, assembled from the chunks that overlap. Gaps are skipped. */
  range(key: LogKey, from: number, to: number): Promise<Buffer>;
  /** The last `maxBytes` of the log (fewer when it is shorter), and where they start. */
  tail(key: LogKey, maxBytes: number): Promise<{ start: number; bytes: Buffer }>;
  /** Chunk count and total bytes (the end of the highest chunk). */
  stat(key: LogKey): Promise<{ chunks: number; size: number }>;
  /**
   * Chunks that contain the pattern, from a cursor, with bounded work per call. A match that
   * spans two chunks is not found here: this is a prefilter, and line matching reads the range.
   */
  grep(key: LogKey, q: LogGrepQuery): Promise<LogGrepResult>;
  /** Removes an attempt's log. */
  deleteAttempt(key: LogKey): Promise<void>;
  /** Removes every log of a project (the project was deleted). */
  deleteProject(orgId: string, projectId: string): Promise<void>;
  /** Total stored bytes of an org (the log quota). */
  orgBytes(orgId: string): Promise<number>;
  /** Waits until everything accepted so far is durable. Throws when the store is unreachable. */
  flush(): Promise<void>;
}

/** Assembles `[from, to)` from chunks. Shared by the backends so they cut identically. */
export function assembleRange(chunks: readonly LogChunk[], from: number, to: number): Buffer {
  if (to <= from) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (const c of chunks) {
    const start = Math.max(from, c.offset) - c.offset;
    const end = Math.min(to, c.offset + c.bytes.length) - c.offset;
    if (end > start) parts.push(c.bytes.subarray(start, end));
  }
  return Buffer.concat(parts);
}
