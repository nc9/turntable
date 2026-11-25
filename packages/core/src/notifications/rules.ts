// The notification rule engine (#611). It reads the append-only event feed past a cursor and
// creates per-person notifications. Pure policy lives here; storage is in db/repos/notifications.
//
// Tenant isolation: a recipient is chosen from the CURRENT members of the event's own org, so a
// person never gets a notification about another org. The read ops join memberships again.
// Nothing from the forge is stored except one escaped, truncated title.
import type { Db } from "../db";
import { myPendingApprovals } from "../approvals/pending";
import {
  addNotification,
  getAttemptInfraKind,
  getNotificationCursor,
  getRun,
  listEventsAfter,
  listMembershipsOfUser,
  listNotificationPrefs,
  listOrgPeople,
  newestEventId,
  parseTrust,
  setNotificationCursor,
  type EventRow,
  type NotificationPref,
  type OrgPerson,
} from "../db/repos";
import { type NotificationKind } from "../db/schema";
import type { SettingsRuntime } from "../settings/resolve";

export const INFRA_WINDOW_MS = 30 * 60 * 1000;
export const HELD_WINDOW_MS = 15 * 60 * 1000;
export const TITLE_MAX = 80;

/** Kinds only an instance operator is told about. Reserved: no rule creates them yet. */
export const OPERATOR_ONLY_KINDS: readonly NotificationKind[] = ["dogfood_red", "deploy_failed"];

/** The default for a kind when a person has set nothing. */
export const KIND_DEFAULTS: Record<NotificationKind, boolean> = {
  run_failed: true,
  infra_errors: true,
  work_held: true,
  approval_waiting: true,
  checkout_auth_failed: true,
  dogfood_red: false,
  deploy_failed: false,
};

/** Escapes markup characters, drops control characters, keeps the first line, truncates. */
export function safeTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  const line = raw.split(/\r?\n/, 1)[0] ?? "";
  const clean = [...line]
    .filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n >= 0x20 && n !== 0x7f && !(n >= 0x80 && n < 0xa0);
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

/** Whether the person wants `kind` for this org and project: project row, then org row, then all, then the default. */
export function prefEnabled(
  prefs: readonly NotificationPref[],
  kind: NotificationKind,
  orgId: string,
  projectId: string | null,
): boolean {
  const find = (o: string, p: string): boolean | undefined =>
    prefs.find((x) => x.kind === kind && x.orgId === o && x.projectId === p)?.enabled;
  return (
    (projectId === null ? undefined : find(orgId, projectId)) ??
    find(orgId, "") ??
    find("", "") ??
    KIND_DEFAULTS[kind]
  );
}

export interface NotificationEngineOptions {
  db: Db;
  now?: () => number;
  settings?: SettingsRuntime | undefined;
  /** Ignore events newer than this many ms (Postgres ids can commit out of order). Default 0. */
  settleMs?: number;
  log?: (m: string) => void;
}

type Candidate = {
  kind: NotificationKind;
  dedupeKey: string;
  runId: string | null;
  title: string;
  coalesce: boolean;
  /** Narrows the people; absent means every member of the org. */
  only?: (p: OrgPerson) => boolean | Promise<boolean>;
};

export class NotificationEngine {
  readonly #o: NotificationEngineOptions;
  readonly #now: () => number;
  #running = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(o: NotificationEngineOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** Processes events past the cursor. A fresh engine starts at the tip: history is not replayed. */
  async tick(maxPages = 10): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    let made = 0;
    try {
      let cursor = await getNotificationCursor(this.#o.db);
      if (cursor === undefined) {
        cursor = await newestEventId(this.#o.db);
        await setNotificationCursor(this.#o.db, cursor);
        return 0;
      }
      const settle = this.#o.settleMs ?? 0;
      for (let i = 0; i < maxPages; i++) {
        const events = await listEventsAfter(
          this.#o.db,
          cursor,
          100,
          settle > 0 ? this.#now() - settle : undefined,
        );
        for (const e of events) {
          made += await this.#handle(e);
          cursor = e.id;
        }
        if (events.length > 0) await setNotificationCursor(this.#o.db, cursor);
        if (events.length < 100) break;
      }
      return made;
    } finally {
      this.#running = false;
    }
  }

  start(intervalMs = 5000): () => void {
    const run = () => void this.tick().catch((e) => this.#o.log?.(`notifications: ${String(e)}`));
    this.#timer = setInterval(run, intervalMs);
    run();
    return () => {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = undefined;
    };
  }

  async #handle(e: EventRow): Promise<number> {
    let candidate: Candidate | undefined;
    try {
      candidate = await this.#candidate(e);
    } catch (err) {
      this.#o.log?.(
        `notifications: event ${e.id}: ${err instanceof Error ? err.message : "error"}`,
      );
      return 0;
    }
    if (!candidate) return 0;
    let made = 0;
    for (const person of await listOrgPeople(this.#o.db, e.orgId)) {
      if (candidate.only && !(await candidate.only(person))) continue;
      const prefs = await listNotificationPrefs(this.#o.db, person.userId);
      if (!prefEnabled(prefs, candidate.kind, e.orgId, e.projectId)) continue;
      const fresh = await addNotification(this.#o.db, {
        userId: person.userId,
        orgId: e.orgId,
        projectId: e.projectId,
        kind: candidate.kind,
        dedupeKey: candidate.dedupeKey,
        runId: candidate.runId,
        title: candidate.title,
        coalesce: candidate.coalesce,
        now: e.createdAt,
      });
      if (fresh) made += 1;
    }
    return made;
  }

  async #candidate(e: EventRow): Promise<Candidate | undefined> {
    const db = this.#o.db;
    const scope = { orgId: e.orgId, ...(e.projectId ? { projectId: e.projectId } : {}) };
    const payload = JSON.parse(e.payload) as Record<string, unknown>;

    if (e.type === "run.finished" && e.runId && payload.status === "failure") {
      const run = await getRun(db, scope, e.runId);
      if (!run) return undefined;
      const klass = parseTrust(run)?.class;
      const mainline = klass === "protected" || klass === "release";
      const prRun = run.event === "pull_request" || run.prNumber !== null;
      if (!mainline && !prRun) return undefined;
      const actor = run.actor?.toLowerCase();
      return {
        kind: "run_failed",
        dedupeKey: e.runId,
        runId: e.runId,
        title: safeTitle(run.commitMessage),
        coalesce: false,
        // A PR run only reaches the person who authored it. (Subscriptions do not exist yet.)
        ...(mainline
          ? {}
          : { only: (p: OrgPerson) => actor !== undefined && p.login?.toLowerCase() === actor }),
      };
    }

    if (e.type === "infra.error" && e.projectId) {
      const window = Math.floor(e.createdAt / INFRA_WINDOW_MS);
      return {
        kind: "infra_errors",
        dedupeKey: `${e.projectId}:${window}`,
        runId: null,
        title: "",
        coalesce: true,
      };
    }

    if (e.type === "quota.reached") {
      const metric = typeof payload.metric === "string" ? payload.metric : "quota";
      return {
        kind: "work_held",
        dedupeKey: `quota:${metric}:${Math.floor(e.createdAt / HELD_WINDOW_MS)}`,
        runId: null,
        title: "",
        coalesce: false,
      };
    }

    if (
      e.type === "job.state_changed" &&
      e.attemptId &&
      payload.level === "attempt" &&
      payload.to === "infra_error"
    ) {
      if ((await getAttemptInfraKind(db, e.orgId, e.attemptId)) !== "checkout_auth_failed")
        return undefined;
      return {
        kind: "checkout_auth_failed",
        dedupeKey: e.runId ?? e.attemptId,
        runId: e.runId,
        title: "",
        coalesce: false,
      };
    }

    if (e.type === "approval.required" && e.runId) {
      const runId = e.runId;
      const settings = this.#o.settings;
      const now = this.#now();
      return {
        kind: "approval_waiting",
        dedupeKey: runId,
        runId,
        title: "",
        coalesce: false,
        // #546's eligibility: only people the approval inbox itself would list the run for.
        only: async (p) => {
          const memberships = (await listMembershipsOfUser(db, p.userId)).filter(
            (m) => m.orgId === e.orgId,
          );
          const items = await myPendingApprovals(db, {
            userId: p.userId,
            memberships,
            now,
            settings,
          });
          return items.some((i) => i.id === runId || i.id.startsWith(`${runId}:`));
        },
      };
    }
    return undefined;
  }
}
