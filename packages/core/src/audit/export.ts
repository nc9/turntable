// Export of the chain to an external sink, so the record outlives the database. Delivery is
// at-least-once: the cursor advances only after the sink accepted a batch, and every line carries
// its seq and hash so a receiver can dedupe and re-verify.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { safeFetch } from "@longshore/net";
import type { Db } from "../db";
import {
  chainedAudit,
  getExportCursor,
  getOrgById,
  listCheckpoints,
  orgsWithAudit,
  setExportCursor,
  type AuditCheckpoint,
  type AuditRow,
} from "../db/repos";

export interface ExportedEntry {
  type: "entry";
  orgId: string;
  seq: number;
  id: string;
  projectId: string | null;
  principalKind: string;
  principalId: string;
  op: string;
  effect: string;
  outcome: string;
  input: string;
  createdAt: number;
  prevHash: string;
  hash: string;
}

export interface ExportedCheckpoint {
  type: "checkpoint";
  orgId: string;
  seq: number;
  hash: string;
  signedAt: number;
  keyId: string;
  signature: string;
}

export type ExportLine = ExportedEntry | ExportedCheckpoint;

export interface AuditSink {
  /** Stable name, used to keep the export cursor. */
  readonly name: string;
  /** Delivers a batch. Throw to leave the cursor where it is. */
  write(orgSlug: string, lines: readonly ExportLine[]): Promise<void>;
}

export const toEntry = (r: AuditRow): ExportedEntry => ({
  type: "entry",
  orgId: r.orgId,
  seq: r.seq as number,
  id: r.id,
  projectId: r.projectId,
  principalKind: r.principalKind,
  principalId: r.principalId,
  op: r.op,
  effect: r.effect,
  outcome: r.outcome,
  input: r.input,
  createdAt: r.createdAt,
  prevHash: r.prevHash as string,
  hash: r.hash as string,
});

export const toCheckpoint = (c: AuditCheckpoint): ExportedCheckpoint => ({
  type: "checkpoint",
  orgId: c.orgId,
  seq: c.seq,
  hash: c.hash,
  signedAt: c.signedAt,
  keyId: c.keyId,
  signature: c.signature,
});

/** Appends JSON lines to `<dir>/audit-<org>.jsonl`, rotating to a timestamped file past `maxBytes`. */
export function jsonlSink(
  dir: string,
  opts: { maxBytes?: number; now?: () => number } = {},
): AuditSink {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  return {
    name: `jsonl:${dir}`,
    async write(orgSlug, lines) {
      mkdirSync(dir, { recursive: true });
      const safe = orgSlug.replaceAll(/[^A-Za-z0-9._-]/g, "_");
      const file = join(dir, `audit-${safe}.jsonl`);
      const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
      if (existsSync(file) && statSync(file).size + body.length > maxBytes) {
        renameSync(file, join(dir, `audit-${safe}-${(opts.now ?? Date.now)()}.jsonl`));
      }
      appendFileSync(file, body, { mode: 0o600 });
    },
  };
}

/**
 * POSTs batches as JSON through the outbound client (address validation applies: a webhook on a
 * private address needs LONGSHORE_NET_ALLOW_HOSTS). With a secret, the body is signed in
 * `x-longshore-signature: sha256=<hmac>`.
 */
export function webhookSink(
  url: string,
  opts: { secret?: string; fetch?: typeof safeFetch } = {},
): AuditSink {
  const f = opts.fetch ?? safeFetch;
  return {
    name: `webhook:${new URL(url).origin}${new URL(url).pathname}`,
    async write(orgSlug, lines) {
      const body = JSON.stringify({ org: orgSlug, lines });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.secret) {
        headers["x-longshore-signature"] =
          `sha256=${createHmac("sha256", opts.secret).update(body).digest("hex")}`;
      }
      const res = await f(url, {
        method: "POST",
        headers,
        body,
        timeoutMs: 30_000,
        maxBytes: 64 * 1024,
      });
      if (!res.ok) throw new Error(`audit webhook answered HTTP ${res.status}`);
    },
  };
}

/**
 * Sends everything after the sink's cursors for one org: entries in batches, then any checkpoints
 * not yet sent (they have their own cursor, because a checkpoint is usually signed after the
 * entries it covers were exported). Each cursor advances only after the sink accepted the batch.
 * Returns how many entries went.
 */
export async function exportOrg(
  db: Db,
  sink: AuditSink,
  org: { id: string; slug: string },
  opts: { batch?: number } = {},
): Promise<number> {
  const batch = opts.batch ?? 500;
  let cursor = await getExportCursor(db, org.id, sink.name);
  let sent = 0;
  for (;;) {
    const rows = await chainedAudit(db, org.id, cursor, batch);
    if (rows.length === 0) break;
    const last = rows.at(-1)?.seq as number;
    await sink.write(org.slug, rows.map(toEntry));
    await setExportCursor(db, org.id, sink.name, last);
    cursor = last;
    sent += rows.length;
  }
  const cpSink = `${sink.name}#checkpoints`;
  const cpCursor = await getExportCursor(db, org.id, cpSink);
  const cps = await listCheckpoints(db, org.id, cpCursor);
  if (cps.length > 0) {
    await sink.write(org.slug, cps.map(toCheckpoint));
    await setExportCursor(db, org.id, cpSink, cps.at(-1)?.seq as number);
  }
  return sent;
}

/** Exports every org with a chain to every sink, once. Returns the number of entries sent. */
export async function exportAll(db: Db, sinks: readonly AuditSink[]): Promise<number> {
  let sent = 0;
  for (const orgId of await orgsWithAudit(db)) {
    const org = await getOrgById(db, orgId);
    if (!org) continue;
    for (const sink of sinks) sent += await exportOrg(db, sink, { id: org.id, slug: org.slug });
  }
  return sent;
}

/** Runs exportAll on an interval. A failing sink is retried next time. Returns a stop function. */
export function startExporter(
  db: Db,
  sinks: readonly AuditSink[],
  opts: { intervalMs?: number; log?: (m: string) => void } = {},
): () => void {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const timer = setInterval(() => {
    exportAll(db, sinks).catch((e: unknown) => log(`audit export failed: ${String(e)}`));
  }, opts.intervalMs ?? 60_000);
  return () => clearInterval(timer);
}
