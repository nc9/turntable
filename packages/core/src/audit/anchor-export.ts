// Off-instance export of each org's latest audit anchor (#362). The anchor is the org's newest
// signed checkpoint: the chain head hash, its sequence and the time, signed with the audit key.
// It goes to the sink the instance administrator configured (a webhook, through the same
// outbound client and HMAC secret as the audit export), on every checkpoint and on an interval.
// What the sink keeps is what `turntable audit verify --anchor` compares a restored or rolled
// back database against, so the sink must be somewhere this instance cannot rewrite.
import type { safeFetch } from "@turntable/net";
import type { Db } from "../db";
import { appendAudit, getOrgById, latestCheckpoint, orgsWithAudit } from "../db/repos";
import type { AuditCheckpoint } from "../db/repos";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";
import {
  auditAnchorExportIntervalSetting,
  auditAnchorSinkUrlSetting,
} from "../settings/definitions";
import { systemOrgId } from "./failures";
import { toCheckpoint, webhookSink, type AuditSink } from "./export";

export interface AnchorExporter {
  /** A checkpoint was signed: send that org's anchor now (not awaited). */
  onCheckpoint(orgId: string, cp?: AuditCheckpoint): void;
  /** Sends every org's anchor when the interval has passed since the last full pass. */
  tick(): Promise<void>;
  /** Sends every org's anchor now. Resolves once the queue has drained. */
  flush(): Promise<void>;
  /** Runs `tick` every `everyMs`. Returns a stop function. */
  start(everyMs?: number): () => void;
}

export interface AnchorExporterOptions {
  db: Db;
  settings: SettingsRuntime;
  /** The HMAC secret of the audit webhook (`TURNTABLE_AUDIT_WEBHOOK_SECRET_FILE`). */
  secret?: string | undefined;
  fetch?: typeof safeFetch;
  now?: () => number;
  log?: (m: string) => void;
}

/** Host and path only: the query string may carry a token. */
const sinkLabel = (url: string): string => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

export function createAnchorExporter(o: AnchorExporterOptions): AnchorExporter {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.warn(m));
  const sent = new Map<string, number>();
  const failing = new Set<string>();
  let lastFull = 0;
  let queue: Promise<void> = Promise.resolve();
  let sink: { url: string; sink: AuditSink } | undefined;

  const sinkFor = async (): Promise<{ url: string; sink: AuditSink } | undefined> => {
    const url = (await resolveSetting(o.settings, o.db, auditAnchorSinkUrlSetting.key))
      .value as string;
    if (url === "") return undefined;
    if (sink?.url !== url) {
      sink = {
        url,
        sink: webhookSink(url, {
          ...(o.secret ? { secret: o.secret } : {}),
          ...(o.fetch ? { fetch: o.fetch } : {}),
        }),
      };
    }
    return sink;
  };

  const record = async (
    outcome: "ok" | "failed",
    org: { id: string; slug: string },
    url: string,
    detail: Record<string, unknown>,
  ): Promise<void> => {
    await appendAudit(
      o.db,
      { orgId: await systemOrgId(o.db) },
      {
        principalKind: "system",
        principalId: "anchor-export",
        op: "audit_anchor_export",
        effect: "write",
        outcome,
        input: { org: org.slug, sink: sinkLabel(url), ...detail },
      },
    );
  };

  const run = async (orgIds: readonly string[]): Promise<void> => {
    const target = await sinkFor();
    if (!target) return;
    const system = await systemOrgId(o.db);
    for (const orgId of orgIds) {
      const cp = await latestCheckpoint(o.db, orgId);
      const org = cp ? await getOrgById(o.db, orgId) : undefined;
      if (!cp || !org) continue;
      try {
        await target.sink.write(org.slug, [toCheckpoint(cp)]);
        failing.delete(orgId);
        // A new anchor is audited. The same one sent again on the interval is not, and nor is the
        // system org's own: an entry per export would make every checkpoint cause the next.
        if (sent.get(orgId) !== cp.seq && orgId !== system) {
          await record("ok", org, target.url, { seq: cp.seq });
        }
        sent.set(orgId, cp.seq);
      } catch (e) {
        // One alert per streak of failures, not one per retry.
        if (!failing.has(orgId)) {
          failing.add(orgId);
          await record("failed", org, target.url, { seq: cp.seq, error: String(e).slice(0, 200) });
        }
        log(`audit anchor export for org ${org.slug} failed: ${String(e)}`);
      }
    }
  };

  const enqueue = (f: () => Promise<void>): Promise<void> => {
    queue = queue.then(f).catch((e: unknown) => log(`audit anchor export failed: ${String(e)}`));
    return queue;
  };

  const all = async (): Promise<void> => {
    lastFull = now();
    await run(await orgsWithAudit(o.db));
  };

  return {
    onCheckpoint(orgId) {
      void enqueue(() => run([orgId]));
    },
    flush: () => enqueue(all),
    async tick() {
      const minutes = (await resolveSetting(o.settings, o.db, auditAnchorExportIntervalSetting.key))
        .value as number;
      if (now() - lastFull >= minutes * 60_000) await enqueue(all);
      else await queue;
    },
    start(everyMs = 60_000) {
      const timer = setInterval(() => {
        void this.tick().catch((e: unknown) => log(`audit anchor export failed: ${String(e)}`));
      }, everyMs);
      return () => clearInterval(timer);
    },
  };
}
