import { beforeEach, expect, test } from "bun:test";
import {
  createOrg,
  createProject,
  type Db,
  getOrgBySlug,
  listProjects,
  openDatabase,
} from "../src/db";
import { Gate } from "../src/db/gate";

let db: Db;
beforeEach(() => {
  db = openDatabase(":memory:");
});

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

test("transaction commits when the async callback resolves", async () => {
  await db.transaction(async (tx) => {
    await createOrg(tx, { slug: "a", name: "A" });
    await tick(); // a real await inside the callback must not commit early
    await createOrg(tx, { slug: "b", name: "B" });
  });
  expect(await getOrgBySlug(db, "a")).toBeDefined();
  expect(await getOrgBySlug(db, "b")).toBeDefined();
});

test("transaction rolls back everything when the callback throws after an await", async () => {
  await expect(
    db.transaction(async (tx) => {
      await createOrg(tx, { slug: "a", name: "A" });
      await tick();
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await getOrgBySlug(db, "a")).toBeUndefined();
  // the connection is usable and not stuck in a transaction
  await db.transaction((tx) => createOrg(tx, { slug: "c", name: "C" }));
  expect(await getOrgBySlug(db, "c")).toBeDefined();
});

test("a failing statement inside a transaction rolls back earlier writes", async () => {
  await expect(
    db.transaction(async (tx) => {
      await createOrg(tx, { slug: "a", name: "A" });
      await createOrg(tx, { slug: "a", name: "dup" }); // unique violation
    }),
  ).rejects.toThrow();
  expect(await getOrgBySlug(db, "a")).toBeUndefined();
});

test("nested transaction is a savepoint: inner failure keeps outer work", async () => {
  await db.transaction(async (tx) => {
    await createOrg(tx, { slug: "outer", name: "O" });
    await expect(
      tx.transaction(async (inner) => {
        await createOrg(inner, { slug: "inner", name: "I" });
        throw new Error("inner boom");
      }),
    ).rejects.toThrow("inner boom");
    await tx.transaction((inner) => createOrg(inner, { slug: "kept", name: "K" }));
  });
  expect(await getOrgBySlug(db, "outer")).toBeDefined();
  expect(await getOrgBySlug(db, "inner")).toBeUndefined();
  expect(await getOrgBySlug(db, "kept")).toBeDefined();
});

test("concurrent repo calls cannot leak into, or be rolled back by, an open transaction", async () => {
  const org = await createOrg(db, { slug: "o", name: "O" });
  let outsideDone = false;
  const outside = (async () => {
    await tick();
    await createProject(db, { orgId: org.id }, { slug: "outside", name: "outside" });
    outsideDone = true;
  })();
  await expect(
    db.transaction(async (tx) => {
      await createProject(tx, { orgId: org.id }, { slug: "inside", name: "inside" });
      await tick();
      await tick();
      await tick();
      // the outside write must be waiting at the gate, not running inside this transaction
      expect(outsideDone).toBe(false);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await outside;
  const slugs = (await listProjects(db, { orgId: org.id })).map((p) => p.slug);
  expect(slugs).toEqual(["outside"]);
});

test("transactions are serialized", async () => {
  const order: string[] = [];
  const run = (name: string) =>
    db.transaction(async () => {
      order.push(`${name}:start`);
      await tick();
      order.push(`${name}:end`);
    });
  await Promise.all([run("a"), run("b"), run("c")]);
  expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("a transaction handle is dead after it ends, and repo calls cannot open a transaction", async () => {
  let leaked: Db | undefined;
  await db.transaction(async (tx) => {
    leaked = tx;
  });
  await expect(createOrg(leaked!, { slug: "late", name: "L" })).rejects.toThrow("after it ended");
  await expect(db.run((h) => h.transaction(async () => {}))).rejects.toThrow("shared gate held");
});

test("gate: shared holders overlap, an exclusive waiter blocks later shared ones", async () => {
  const gate = new Gate();
  const r1 = await gate.shared();
  const r2 = await gate.shared();
  const events: string[] = [];
  const w = gate.exclusive().then((release) => {
    events.push("w");
    return release;
  });
  const r3 = gate.shared().then((release) => {
    events.push("r3");
    return release;
  });
  await tick();
  expect(events).toEqual([]);
  r1();
  r2();
  (await w)();
  (await r3)();
  expect(events).toEqual(["w", "r3"]);
});

test("root db inside a transaction joins it instead of deadlocking", async () => {
  await db.transaction(async () => {
    await createOrg(db, { slug: "joined", name: "J" }); // root handle, same async context
    expect(await getOrgBySlug(db, "joined")).toBeDefined();
  });
  expect(await getOrgBySlug(db, "joined")).toBeDefined();
});

test("a rollback undoes root-db calls made inside the transaction", async () => {
  await expect(
    db.transaction(async () => {
      await createOrg(db, { slug: "gone", name: "G" });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(await getOrgBySlug(db, "gone")).toBeUndefined();
});

test("root db.transaction inside a transaction is a savepoint", async () => {
  await db.transaction(async () => {
    await createOrg(db, { slug: "keep", name: "K" });
    await expect(
      db.transaction(async () => {
        await createOrg(db, { slug: "drop", name: "D" });
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
  });
  expect(await getOrgBySlug(db, "keep")).toBeDefined();
  expect(await getOrgBySlug(db, "drop")).toBeUndefined();
});

test("root db.transaction inside a plain repo call throws instead of hanging", async () => {
  await expect(db.run(() => db.transaction(async () => {}))).rejects.toThrow("shared gate held");
});

test("root run inside a repo call joins it (no gate re-entry)", async () => {
  await db.run(async () => {
    await createOrg(db, { slug: "nested", name: "N" });
  });
  expect(await getOrgBySlug(db, "nested")).toBeDefined();
});
