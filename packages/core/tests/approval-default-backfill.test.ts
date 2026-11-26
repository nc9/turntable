// The boot backfill of the strict approval default (#663), and a source guard that every write
// to org_members calls ratchetApprovalDefault.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { eq } from "drizzle-orm";
import { createOrg, createUser, openDatabase, type Db } from "../src/db";
import {
  approvalDefaultMode,
  backfillApprovalDefaultStrict,
} from "../src/db/repos/approval-default";
import * as s from "../src/db/schema";

/** A membership written the way a pre-ratchet build did: no marker. */
async function legacyMember(db: Db, orgId: string, role: "owner" | "admin" | "member") {
  const u = await createUser(db, { displayName: `${role}-${Math.random()}` });
  await db.orm.insert(s.orgMembers).values({ orgId, userId: u.id, role });
  return u.id;
}

describe("approval default backfill", () => {
  test("an org with two admins before the upgrade stays strict after one leaves", async () => {
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "two", name: "Two" });
    await legacyMember(db, org.id, "owner");
    const second = await legacyMember(db, org.id, "admin");
    expect(await backfillApprovalDefaultStrict(db)).toBe(1);
    await db.orm.delete(s.orgMembers).where(eq(s.orgMembers.userId, second));
    expect(await approvalDefaultMode(db, org.id)).toBe("strict");
    // Idempotent: a second boot marks nothing new.
    expect(await backfillApprovalDefaultStrict(db)).toBe(0);
  });

  test("an org with one admin stays solo, and a plain member does not count", async () => {
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "one", name: "One" });
    await legacyMember(db, org.id, "owner");
    await legacyMember(db, org.id, "member");
    expect(await backfillApprovalDefaultStrict(db)).toBe(0);
    expect(await approvalDefaultMode(db, org.id)).toBe("solo");
  });
});

describe("org_members write guard", () => {
  test("every source file that inserts or updates org_members calls ratchetApprovalDefault", async () => {
    const write =
      /(insert|update)\(\s*(s\.)?orgMembers\b|insert\s+into\s+"?org_members|update\s+"?org_members/i;
    const offenders: string[] = [];
    const root = new URL("../src/", import.meta.url).pathname;
    for await (const f of new Glob("**/*.ts").scan(root)) {
      if (f.endsWith("approval-default.ts")) continue;
      const text = await Bun.file(root + f).text();
      if (write.test(text) && !text.includes("ratchetApprovalDefault")) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
