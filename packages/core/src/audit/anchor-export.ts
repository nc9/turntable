// Off-instance export of each org's latest audit anchor (#362). The anchor is the org's newest
// signed checkpoint: the chain head hash, its sequence and the time, signed with the audit key.
// It goes to the sink the instance administrator configured, on every checkpoint and on an
// interval. What the sink keeps is what `turntable audit verify --anchor` compares a restored or
// rolled back database against, so the sink must be somewhere this instance cannot rewrite.
//
// The body is only `ANCHOR_KEYS` and nothing else: no org slug, name or count. The sink sees an
// opaque org id, a position, a hash and a signature. The body is signed with the audit webhook
// secret in `x-longshore-signature` (a frozen header name), the same as the audit export.
//
// Sending never sits on the checkpoint path. `onCheckpoint` returns at once; a sink that is down or
// hangs is retried with a bounded exponential backoff, and the failure is audited once per streak.
import { createHmac } from "node:crypto";
import { safeFetch } from "@turntable/net";
import type { Db } from "../db";
import { appendAudit, getOrgById, latestCheckpoint, orgsWithAudit } from "../db/repos";
import type { AuditCheckpoint } from "../db/repos";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";
import {
  auditAnchorExportIntervalSetting,
  auditAnchorSinkUrlSetting,
} from "../settings/definitions";
import { systemOrgId } from "./failures";

/** The exact keys of an exported anchor. `version` is fixed so a reader can tell the shape. */
export const ANCHOR_KEYS = ["version", "org_id", "sequence", "head_hash", "time", "signature"];

export interface ExportedAnchor {
  version: 1;
  org_id: string;
  sequence: number;
  head_hash: string;
  time: number;
  signature: string;
}

export const toAnchor = (c: AuditCheckpoint): ExportedAnchor => ({
  version: 1,
  org_id: c.orgId,
  sequence: c.seq,
  head_hash: c.hash,
  time: c.signedAt,
  signature: c.signature,
});

/** Retry delays: 5 s doubling to 15 min. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const SEND_TIMEOUT_MS = 10_000;
export const backoffMs = (attempt: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);

export interface AnchorExporter {
  /** A checkpoint was signed: send that org's anchor soon (never awaited, never throws). */
  onCheckpoint(orgId: string, cp?: AuditCheckpoint): void;
  /** Sends every org's anchor when the interval has passed since the last full pass. */
  tick(): Promise<void>;
  /** Sends every org's anchor now. Resolves once each has had one attempt; retries run later. */
  flush(): Promise<void>;
  /** Runs `tick` every `everyMs`. Returns a stop function that also cancels pending retries. */
  start(everyMs?: number): () => void;
}

export interface AnchorExporterOptions {
  db: Db;
  settings: SettingsRuntime;
  /** The HMAC secret of the audit webhook (see webhook-secret.ts). */
  secret?: string | undefined;
  fetch?: typeof safeFetch;
  now?: () => number;
  log?: (m: string) => void;
  /** Schedules a retry. Tests pass a fake; the default is an unref'd `setTimeout`. */
  setTimer?: (f: () => void, ms: number) => () => void;
}

/** Host and path only: the query string may carry a token. */
const sinkLabel = (url: string): string => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

const defaultTimer = (f: () => void, ms: number): (() => void) => {
  const t = setTimeout(f, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

interface OrgState {
  /** The attempt in flight, if any. */
  inflight?: Promise<void> | undefined;
  /** A newer anchor arrived while one was in flight. */
  dirty: boolean;
  /** Consecutive failures: 0 when the last send worked. */
  attempt: number;
  /** Cancels the pending retry, which exists exactly while one is waiting. */
  cancel?: (() => void) | undefined;
  /** The last sequence sent and accepted. */
  sentSeq?: number;
}

export function createAnchorExporter(o: AnchorExporterOptions): AnchorExporter {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.warn(m));
  const f = o.fetch ?? safeFetch;
  const setTimer = o.setTimer ?? defaultTimer;
  const states = new Map<string, OrgState>();
  let lastFull = 0;
  let stopped = false;

  const stateOf = (orgId: string): OrgState => {
    let st = states.get(orgId);
    if (!st) states.set(orgId, (st = { dirty: false, attempt: 0 }));
    return st;
  };

  const sinkUrl = async (): Promise<string> =>
    (await resolveSetting(o.settings, o.db, auditAnchorSinkUrlSetting.key)).value as string;

  const post = async (url: string, anchor: ExportedAnchor): Promise<void> => {
    const body = JSON.stringify(anchor);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (o.secret) {
      headers["x-longshore-signature"] =
        `sha256=${createHmac("sha256", o.secret).update(body).digest("hex")}`;
    }
    const res = await f(url, {
      method: "POST",
      headers,
      body,
      timeoutMs: SEND_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
    if (!res.ok) throw new Error(`anchor sink answered HTTP ${res.status}`);
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

  /** One attempt for one org: its latest anchor to the sink. Never throws. */
  const attempt = async (orgId: string, st: OrgState): Promise<void> => {
    try {
      const url = await sinkUrl();
      if (url === "") return;
      const cp = await latestCheckpoint(o.db, orgId);
      const org = cp ? await getOrgById(o.db, orgId) : undefined;
      if (!cp || !org) return;
      try {
        await post(url, toAnchor(cp));
      } catch (e) {
        // One alert per streak of failures, not one per retry.
        if (st.attempt === 0) {
          await record("failed", org, url, { seq: cp.seq, error: String(e).slice(0, 200) });
        }
        st.attempt += 1;
        const wait = backoffMs(st.attempt);
        log(`audit anchor export for org ${org.slug} failed (retry in ${wait} ms): ${String(e)}`);
        if (!stopped) st.cancel = setTimer(() => retry(orgId, st), wait);
        return;
      }
      st.attempt = 0;
      // A new anchor is audited. The same one sent again on the interval is not, and nor is the
      // system org's own: an entry per export would make every checkpoint cause the next.
      if (st.sentSeq !== cp.seq && orgId !== (await systemOrgId(o.db))) {
        await record("ok", org, url, { seq: cp.seq });
      }
      st.sentSeq = cp.seq;
    } catch (e) {
      log(`audit anchor export failed: ${String(e)}`);
    }
  };

  /** Starts an attempt unless one is running (then it runs again after) or a retry is waiting. */
  const send = (orgId: string): Promise<void> => {
    const st = stateOf(orgId);
    if (st.cancel) return Promise.resolve();
    if (st.inflight) {
      st.dirty = true;
      return st.inflight;
    }
    const run = (async () => {
      do {
        st.dirty = false;
        await attempt(orgId, st);
      } while (st.dirty && !st.cancel && !stopped);
    })().finally(() => {
      st.inflight = undefined;
    });
    st.inflight = run;
    return run;
  };

  const retry = (orgId: string, st: OrgState): void => {
    st.cancel = undefined;
    if (!stopped) void send(orgId);
  };

  const all = async (): Promise<void> => {
    lastFull = now();
    const ids = await orgsWithAudit(o.db);
    await Promise.all(ids.map((id) => send(id)));
  };

  return {
    onCheckpoint(orgId) {
      void send(orgId);
    },
    flush: all,
    async tick() {
      const minutes = (await resolveSetting(o.settings, o.db, auditAnchorExportIntervalSetting.key))
        .value as number;
      if (now() - lastFull >= minutes * 60_000) await all();
    },
    start(everyMs = 60_000) {
      stopped = false;
      const timer = setInterval(() => {
        void this.tick().catch((e: unknown) => log(`audit anchor export failed: ${String(e)}`));
      }, everyMs);
      return () => {
        clearInterval(timer);
        stopped = true;
        for (const st of states.values()) st.cancel?.();
      };
    },
  };
}
