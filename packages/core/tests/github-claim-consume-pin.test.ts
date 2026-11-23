// consumeInstallationClaim enforces the installation pin in its WHERE (#391), on both dialects.
import { afterAll, describe, expect, test } from "bun:test";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import {
  consumeInstallationClaim,
  createInstallationClaim,
  createOrg,
  type Db,
  getInstallationClaim,
  openDatabase,
} from "../src/db";

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite"
    ? { url: t, schema: `lstest_claimpin_${process.pid}` }
    : { pglite: true };
};

const opened: Db[] = [];
const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres(pgTarget(), { fresh: true })],
];
afterAll(() => {
  for (const db of opened) db.close();
});

const now = 1_800_000_000_000;
const gh = { userId: "1", login: "acme" };

describe.each(dialects)("consumeInstallationClaim and the installation pin (%s)", (_n, open) => {
  const fresh = async () => {
    const db = open();
    opened.push(db);
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    return { db, orgId: org.id };
  };

  test("a claim pinned to A is not consumed with B and stays unspent", async () => {
    const { db, orgId } = await fresh();
    await createInstallationClaim(
      db,
      { orgId },
      { nonce: "n1", startedBy: "u", expiresAt: now + 1000, installationId: "A" },
    );
    expect(await consumeInstallationClaim(db, "n1", "B", now, gh)).toBeUndefined();
    expect(await getInstallationClaim(db, "n1")).toMatchObject({
      usedAt: null,
      installationId: "A",
      githubLogin: null,
    });
  });

  test("a claim pinned to A is consumed with A", async () => {
    const { db, orgId } = await fresh();
    await createInstallationClaim(
      db,
      { orgId },
      { nonce: "n2", startedBy: "u", expiresAt: now + 1000, installationId: "A" },
    );
    expect(await consumeInstallationClaim(db, "n2", "A", now, gh)).toMatchObject({
      nonce: "n2",
      installationId: "A",
      usedAt: now,
    });
    // Single use still holds.
    expect(await consumeInstallationClaim(db, "n2", "A", now, gh)).toBeUndefined();
  });

  test("an unpinned claim is consumed with any installation id", async () => {
    const { db, orgId } = await fresh();
    await createInstallationClaim(
      db,
      { orgId },
      { nonce: "n3", startedBy: "u", expiresAt: now + 1000 },
    );
    expect(await consumeInstallationClaim(db, "n3", "Z", now, gh)).toMatchObject({
      nonce: "n3",
      installationId: "Z",
      usedAt: now,
    });
  });
});
