// The `VACUUM INTO` of a backup, run on a worker thread (#310) so the server's event loop keeps
// serving while a large database is copied. bun:sqlite is synchronous: on the main thread the copy
// would stall heartbeats, log streaming and the API for its whole duration.
//
// Keep this file self-contained (bun:sqlite only): the compiled binary embeds it as its own
// entrypoint (scripts/build.ts) and `backup.ts` starts it by its path inside the executable.
import { Database } from "bun:sqlite";

export type BackupWorkerRequest = {
  dbPath: string;
  partial: string;
  busyTimeoutMs: number;
  /** TEST ONLY: block this thread for this long after the copy, to stand in for a big database. */
  holdMs?: number | undefined;
};
export type BackupWorkerReply = { ok: true } | { ok: false; message: string };

declare const self: Worker;

self.onmessage = (event: MessageEvent<BackupWorkerRequest>) => {
  const { dbPath, partial, busyTimeoutMs, holdMs } = event.data;
  let reply: BackupWorkerReply = { ok: true };
  try {
    const src = new Database(dbPath, { readonly: true, strict: true });
    try {
      src.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      src.run("VACUUM INTO ?", [partial]);
    } finally {
      src.close();
    }
    if (holdMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  } catch (err) {
    reply = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  postMessage(reply);
};
