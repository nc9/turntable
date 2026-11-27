// `sandboxSpans` reads only attempts created within MAX_SPAN_MS before the window, so its cost
// does not grow with an org's history (#764). The bound must not change what is counted.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAttempt,
  type Db,
  MAX_SPAN_MS,
  sandboxSpans,
  spanMs,
  spanRowsQuery,
} from "../src/db";
import * as s from "../src/db/schema";
import { seedWorld, type Tenant } from "./ops-helpers";
import { onPostgres } from "./pg-mode";

const H = 3_600_000;
const DAY = 24 * H;
const D0 = Date.UTC(2026, 10, 1);
const NOW = D0 + 20 * DAY;
const W = { from: D0 + 10 * DAY, to: D0 + 17 * DAY, now: NOW };

let db: Db;
let a: Tenant;
beforeEach(async () => {
  ({ db, a } = await seedWorld());
});

interface Row {
  created: number;
  destroyed?: number | null;
  finished?: number | null;
  state?: string;
  ttl?: number | null;
}

async function insert(t: Tenant, rows: Row[]): Promise<void> {
  for (const r of rows) {
    const att = (await createAttempt(db, t.scope, { jobId: t.jobId, provider: "test" }))!;
    await db.orm
      .update(s.jobAttempts)
      .set({
        sandboxCreatedAt: r.created,
        sandboxDestroyedAt: r.destroyed ?? null,
        finishedAt: r.finished ?? null,
        ...(r.state ? { state: r.state as "running" } : {}),
        sandboxTtlSeconds: r.ttl ?? null,
      })
      .where(eq(s.jobAttempts.id, att.id));
  }
}

/** The unbounded reading of today's rules, in JS, over every attempt of the org. */
async function reference(t: Tenant): Promise<number> {
  const all = await db.orm.select().from(s.jobAttempts).where(eq(s.jobAttempts.orgId, t.orgId));
  let ms = 0;
  for (const r of all) {
    if (r.sandboxCreatedAt === null) continue;
    const begin = r.sandboxCreatedAt;
    let end: number;
    if (r.sandboxDestroyedAt !== null) end = r.sandboxDestroyedAt;
    else {
      const live = r.finishedAt === null && r.state === "running";
      end = r.finishedAt ?? (live ? W.now : begin);
      if (r.sandboxTtlSeconds !== null && r.sandboxTtlSeconds > 0)
        end = Math.min(end, begin + r.sandboxTtlSeconds * 1000);
    }
    end = Math.max(begin, end);
    ms += Math.max(0, Math.min(end, W.to) - Math.max(begin, W.from));
  }
  return ms;
}

describe("the lower bound keeps today's spans", () => {
  test("inside, straddling the start, running, lost and destroyed-after-start attempts", async () => {
    const { from, to } = W;
    await insert(a, [
      { created: from + H, destroyed: from + 2 * H }, // inside
      { created: from - 30 * 60_000, destroyed: from + 30 * 60_000 }, // straddles the start
      { created: to - H, destroyed: null, finished: null, state: "running", ttl: 4500 }, // running, TTL-capped
      { created: to - 10 * 60_000, destroyed: null, finished: null, state: "running" }, // running, to now
      { created: from + 5 * H }, // lost: no destroy, no finish, not running
      { created: from - 2 * H, finished: from + H }, // finished, destroy never confirmed
      { created: from - 47 * H, destroyed: from + H }, // long-lived, destroyed after the start
      { created: from - 47 * H, destroyed: from - 46 * H }, // ended long before: counts 0
      { created: from - 30 * DAY, destroyed: from - 30 * DAY + H }, // old history: counts 0
      { created: from - 30 * DAY, finished: from - 30 * DAY + H }, // old, finished
    ]);
    const spans = await sandboxSpans(db, a.scope, W);
    const bounded = spanMs(spans, W.from, W.to);
    expect(bounded).toBeGreaterThan(0);
    expect(bounded).toBe(await reference(a));
    // the straddling attempt contributes only its half hour in the window
    expect(
      spans.some((sp) => sp.start === from - 30 * 60_000 && sp.end === from + 30 * 60_000),
    ).toBe(true);
    // a running attempt with a TTL is capped by it; one without runs to now, clipped by the window
    expect(spans.find((sp) => sp.start === to - H)!.end).toBe(to - H + 4500_000);
    expect(spans.find((sp) => sp.start === to - 10 * 60_000)!.end).toBe(NOW);
  });

  test("a running attempt just inside the bound is still read; just outside it is not", async () => {
    const edge = W.from - MAX_SPAN_MS;
    await insert(a, [
      { created: edge, destroyed: null, finished: null, state: "running" },
      { created: edge - 1, destroyed: null, finished: null, state: "running" },
    ]);
    const starts = (await sandboxSpans(db, a.scope, W)).map((sp) => sp.start);
    expect(starts).toEqual([edge]);
  });
});

describe("cost does not follow history", () => {
  const OLD = 20_000;

  async function bulkOld(t: Tenant, n: number): Promise<void> {
    const att = (await createAttempt(db, t.scope, { jobId: t.jobId, provider: "test" }))!;
    const [tpl] = await db.orm.select().from(s.jobAttempts).where(eq(s.jobAttempts.id, att.id));
    const rows = Array.from({ length: n }, (_, i) => ({
      ...tpl!,
      id: `old${t.orgId.slice(-6)}${i}`,
      attempt: 1000 + i,
      sandboxCreatedAt: W.from - 5 * DAY - i * 1000,
      sandboxDestroyedAt: null,
      finishedAt: null,
      state: "running" as const,
      sandboxTtlSeconds: null,
    }));
    for (let i = 0; i < rows.length; i += 500)
      await db.orm.insert(s.jobAttempts).values(rows.slice(i, i + 500));
  }

  test("the rows the query reads are the same with or without old attempts", async () => {
    await insert(a, [{ created: W.from + H, destroyed: W.from + 2 * H }]);
    const before = await spanRowsQuery(db.orm, a.scope, W);
    await bulkOld(a, OLD);
    const total = await db.orm
      .select({ n: sql<number>`count(*)` })
      .from(s.jobAttempts)
      .where(eq(s.jobAttempts.orgId, a.orgId));
    expect(Number(total[0]!.n)).toBeGreaterThan(OLD);
    const after = await spanRowsQuery(db.orm, a.scope, W);
    expect(after).toEqual(before);
    expect(after.length).toBe(1);
  });

  test("the plan is a range scan on the sandbox index with both bounds", async () => {
    const q = spanRowsQuery(db.orm, a.scope, W);
    if (onPostgres) {
      const pg = db.orm as unknown as { execute(q: unknown): Promise<unknown> };
      // A tiny table plans a seq scan; the check is that the index can serve both bounds.
      await pg.execute(sql`set enable_seqscan = off`);
      const res = (await pg.execute(sql`explain ${q.getSQL()}`)) as unknown as
        Record<string, string>[] | { rows: Record<string, string>[] };
      const text = (Array.isArray(res) ? res : res.rows)
        .map((r) => Object.values(r).join(" "))
        .join("\n");
      expect(text).toContain("job_attempts_sandbox_idx");
      expect(text).toMatch(/sandbox_created_at\s*>=/);
      expect(text).toMatch(/sandbox_created_at\s*</);
      await pg.execute(sql`set enable_seqscan = on`);
    } else {
      const rows = (await (db.orm as unknown as { all(q: unknown): unknown }).all(
        sql`explain query plan ${q.getSQL()}`,
      )) as { detail: string }[];
      const text = rows.map((r) => r.detail).join("\n");
      expect(text).toContain("USING INDEX job_attempts_sandbox_idx");
      expect(text).toMatch(/sandbox_created_at>\?/);
      expect(text).toMatch(/sandbox_created_at<\?/);
    }
  });
});
