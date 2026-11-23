// What the Postgres Db does that the SQLite one gets from its single exclusive connection.
// Runs on whichever Postgres the suite is pointed at (PGlite by default; a real server with
// LONGSHORE_TEST_DB=postgres://... exercises the real concurrency and the retry).
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createOrg, createProject, type Db, listAudit, listProjects } from "../src/db";
import { appendAudit } from "../src/db/repos";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";

const target = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite" ? { url: t, schema: `lstest_tx_${process.pid}` } : { pglite: true };
};

let db: Db;
beforeEach(() => {
  db = openPostgres(target(), { fresh: true });
});
afterAll(() => db?.close());

const serializationFailure = () =>
  Object.assign(new Error("could not serialize access"), { code: "40001" });

test("concurrent read-then-write transactions end up correct: the audit chain gets 1..N with no gap or duplicate", async () => {
  const org = await createOrg(db, { slug: "o", name: "O" });
  const n = 12;
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      appendAudit(
        db,
        { orgId: org.id },
        {
          principalKind: "system",
          principalId: "t",
          op: `op${i}`,
          effect: "write",
          outcome: "ok",
          input: { i },
        },
      ),
    ),
  );
  const rows = (await listAudit(db, { orgId: org.id }, { limit: 100 })).filter(
    (r) => r.seq !== null,
  );
  expect(rows.map((r) => r.seq).toSorted((a, b) => (a as number) - (b as number))).toEqual(
    Array.from({ length: n }, (_, i) => i + 1),
  );
});

test("a serialization failure runs the transaction again; hooks fire once, for the attempt that committed", async () => {
  let attempts = 0;
  const fired: number[] = [];
  const out = await db.transaction(async (tx) => {
    attempts++;
    const mine = attempts;
    tx.afterCommit(() => void fired.push(mine));
    await createOrg(tx, { slug: `try${mine}`, name: "T" });
    if (attempts === 1) throw serializationFailure();
    return "done";
  });
  expect(out).toBe("done");
  expect(attempts).toBe(2);
  expect(fired).toEqual([2]);
  // the failed attempt left nothing behind
  const { getOrgBySlug } = await import("../src/db");
  expect(await getOrgBySlug(db, "try1")).toBeUndefined();
  expect(await getOrgBySlug(db, "try2")).toBeDefined();
});

test("any other error is not retried, and rolls back", async () => {
  let attempts = 0;
  await expect(
    db.transaction(async (tx) => {
      attempts++;
      await createOrg(tx, { slug: "gone", name: "G" });
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(attempts).toBe(1);
  const { getOrgBySlug } = await import("../src/db");
  expect(await getOrgBySlug(db, "gone")).toBeUndefined();
});

test("a savepoint rolls back alone, and its hooks are dropped with it", async () => {
  const org = await createOrg(db, { slug: "sp", name: "S" });
  const fired: string[] = [];
  await db.transaction(async (tx) => {
    await createProject(tx, { orgId: org.id }, { slug: "kept", name: "K" });
    await expect(
      tx.transaction(async (inner) => {
        inner.afterCommit(() => void fired.push("inner"));
        await createProject(inner, { orgId: org.id }, { slug: "dropped", name: "D" });
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
    tx.afterCommit(() => void fired.push("outer"));
  });
  expect((await listProjects(db, { orgId: org.id })).map((p) => p.slug)).toEqual(["kept"]);
  expect(fired).toEqual(["outer"]);
});

test("a root db used inside a transaction joins it; a handle outlives its transaction by erroring", async () => {
  let leaked: Db | undefined;
  await expect(
    db.transaction(async (tx) => {
      leaked = tx;
      await createOrg(db, { slug: "joined", name: "J" }); // the root handle, same transaction
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  const { getOrgBySlug } = await import("../src/db");
  expect(await getOrgBySlug(db, "joined")).toBeUndefined(); // it was rolled back with the transaction
  await expect(createOrg(leaked!, { slug: "late", name: "L" })).rejects.toThrow("after it ended");
});

test("root transactions that name the same lock key run one after another; others are not held back", async () => {
  let running = 0;
  let maxSame = 0;
  const order: string[] = [];
  const work = (key: string, name: string) =>
    db.transaction(
      async () => {
        running++;
        maxSame = Math.max(maxSame, running);
        order.push(`${name}:start`);
        await Bun.sleep(5);
        order.push(`${name}:end`);
        running--;
      },
      { lock: key },
    );
  await Promise.all(["a", "b", "c", "d", "e"].map((n) => work("audit:org1", n)));
  expect(maxSame).toBe(1); // never two at once for one key
  // each finished before the next started, in the order they were asked
  expect(order).toEqual(["a", "b", "c", "d", "e"].flatMap((n) => [`${n}:start`, `${n}:end`]));
  // a failing one does not stop the queue behind it
  const results = await Promise.allSettled([
    db.transaction(
      async () => {
        throw new Error("first fails");
      },
      { lock: "k" },
    ),
    db.transaction(async () => "second runs", { lock: "k" }),
  ]);
  expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
});

test("many concurrent writes to one org, through the op dispatcher's lock, land as a clean audit chain", async () => {
  const org = await createOrg(db, { slug: "hot", name: "Hot" });
  const n = 40;
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      db.transaction(
        async (tx) => {
          await appendAudit(
            tx,
            { orgId: org.id },
            {
              principalKind: "system",
              principalId: "t",
              op: `w${i}`,
              effect: "write",
              outcome: "ok",
              input: { i },
            },
          );
        },
        { lock: `audit:${org.id}` },
      ),
    ),
  );
  const rows = (await listAudit(db, { orgId: org.id }, { limit: 200 })).filter(
    (r) => r.seq !== null,
  );
  expect(rows.map((r) => r.seq).toSorted((a, b) => (a as number) - (b as number))).toEqual(
    Array.from({ length: n }, (_, i) => i + 1),
  );
});
