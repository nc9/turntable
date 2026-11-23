// The release lane signs files, not zips: an artifact zip is unpacked safely and each file in it
// is a subject. These drive the lane with zip artifacts; the unpacker's own rejections are in
// release-unpack.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createReleaseRequest, getReleaseRequest, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { resetFailureThrottle } from "../src/audit/failures";
import { AttestationStore } from "../src/release/attest";
import { ReleaseLane, type ReleaseSigner } from "../src/release/lane";
import { seedWorld, type Tenant } from "./ops-helpers";
import { buildZip, type ZipEntry } from "./helpers/zip-builder";

const SHA = "a".repeat(40);
const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
const hex = (b: Uint8Array | string): string =>
  createHash("sha256")
    .update(typeof b === "string" ? b : b)
    .digest("hex");

let db: Db;
let a: Tenant;
let root: string;
let blobs: Map<string, Uint8Array>;
let attest: AttestationStore;
let lane: ReleaseLane;
let signed: Parameters<ReleaseSigner["signRelease"]>[1][];

const signer: ReleaseSigner = {
  async signRelease(_scope, req) {
    signed.push(req);
    return {
      ok: true,
      envelope: { payload: "x", signatures: [{ keyid: "k1", sig: "y" }] },
      keyid: "k1",
      subjects: [...req.verified.subjects],
    };
  },
};

/** Stores an artifact (as the build uploaded it) and records its digest as the main DB would. */
const put = async (name: string, bytes: Uint8Array): Promise<void> => {
  blobs.set(`${a.runId}/${name}`, bytes);
  await recordArtifactRow(name, bytes);
};
const rows = new Map<string, { sha256: string; size: number }>();
const recordArtifactRow = async (name: string, bytes: Uint8Array): Promise<void> => {
  rows.set(`${a.runId}/${name}`, { sha256: hex(bytes), size: bytes.length });
};
const putZip = (name: string, entries: ZipEntry[]) => put(name, buildZip(entries));

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  resetFailureThrottle();
  root = mkdtempSync(join(tmpdir(), "tt-lane-zip-"));
  blobs = new Map();
  rows.clear();
  signed = [];
  attest = new AttestationStore(":memory:");
  attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
  lane = new ReleaseLane({
    db,
    forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
    bytes: { read: async (runId, name) => blobs.get(`${runId}/${name}`) },
    records: {
      recorded: async (_scope, runId, names) =>
        names.flatMap((n) => {
          const r = rows.get(`${runId}/${n}`);
          return r ? [{ name: n, ...r }] : [];
        }),
    },
    attest,
    signer,
    owner: "lane-1",
    unpackRoot: root,
    now: () => 1_800_000_000_000,
  });
  await db.orm
    .update(s.runs)
    .set({ repo: "acme/web", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
    .where(eq(s.runs.id, a.runId));
});
afterEach(() => {
  attest.close();
  rmSync(root, { recursive: true, force: true });
});

const release = async (artifacts: string[]) => {
  const r = await createReleaseRequest(db, a.scope, {
    runId: a.runId,
    tag: "v1.0.0",
    artifacts,
    requestedBy: "test",
  });
  expect(await lane.processNext()).toBe(true);
  return (await getReleaseRequest(db, a.scope, r.id))!;
};

describe("the lane signs the files inside an artifact zip", () => {
  test("the subjects are the extracted files' names and digests; the zip is only listed as an archive", async () => {
    const zip = buildZip([
      { name: "turntable-linux-x64", data: "ELF" },
      { name: "turntable-darwin-arm64", data: "MACHO" },
    ]);
    await put("binaries", zip);
    const row = await release(["binaries"]);
    expect(row.status).toBe("signed");
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatchObject({
      artifacts: ["binaries"],
      verified: {
        subjects: [
          { name: "turntable-darwin-arm64", sha256: hex("MACHO") },
          { name: "turntable-linux-x64", sha256: hex("ELF") },
        ],
        archives: [{ name: "binaries", sha256: hex(zip) }],
      },
    });
    // The statement does not name the zip.
    expect(signed[0]!.verified.subjects.map((x) => x.name)).not.toContain("binaries");
    // The unpacked files are gone once the request is done.
    expect(readdirSync(root)).toEqual([]);
  });

  test("a raw artifact (archive: false) and a zip in one request: both are signed by what they hold", async () => {
    await put("turntable-linux-x64", enc("ELF-raw"));
    await putZip("extra", [{ name: "docs/readme.txt", data: "hello" }]);
    const row = await release(["turntable-linux-x64", "extra"]);
    expect(row.status).toBe("signed");
    expect(signed[0]!.verified.subjects).toEqual([
      { name: "turntable-linux-x64", sha256: hex("ELF-raw") },
      { name: "docs/readme.txt", sha256: hex("hello") },
    ]);
  });

  test("a zip that does not match its recorded digest is refused before anything is unpacked", async () => {
    await putZip("binaries", [{ name: "a", data: "1" }]);
    blobs.set(`${a.runId}/binaries`, buildZip([{ name: "a", data: "tampered" }]));
    const row = await release(["binaries"]);
    expect(row).toMatchObject({ status: "refused", reason: "digest_mismatch" });
    expect(signed).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  const unsafe: [string, ZipEntry[]][] = [
    ["an absolute path", [{ name: "/abs", data: "x" }]],
    ["a .. segment", [{ name: "../up", data: "x" }]],
    ["a symlink", [{ name: "l", data: "x", mode: 0o120777 }]],
    ["a device file", [{ name: "d", data: "", mode: 0o020644 }]],
    [
      "a duplicate name",
      [
        { name: "a", data: "1" },
        { name: "a", data: "2" },
      ],
    ],
  ];
  for (const [what, entries] of unsafe) {
    test(`a zip with ${what} is refused, nothing is signed and nothing is left on disk`, async () => {
      await putZip("binaries", entries);
      const row = await release(["binaries"]);
      expect(row).toMatchObject({ status: "refused", reason: "unpack_failed" });
      expect(row.detail).toContain("binaries");
      expect(signed).toEqual([]);
      expect(readdirSync(root)).toEqual([]);
    });
  }

  test("two artifacts that hold a file of the same name are refused: a subject name means one thing", async () => {
    await putZip("one", [{ name: "tool", data: "1" }]);
    await putZip("two", [{ name: "tool", data: "2" }]);
    const row = await release(["one", "two"]);
    expect(row).toMatchObject({ status: "refused", reason: "duplicate_subject" });
    expect(signed).toEqual([]);
  });

  test("a file in a zip that has the name of a raw artifact is refused too", async () => {
    await put("tool", enc("raw"));
    await putZip("one", [{ name: "tool", data: "in-zip" }]);
    expect((await release(["tool", "one"])).reason).toBe("duplicate_subject");
  });

  test("the zip is removed on a refusal after unpacking as well (the signer says no)", async () => {
    await putZip("binaries", [{ name: "a", data: "1" }]);
    const refusing = new ReleaseLane({
      db,
      forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
      bytes: { read: async (runId, name) => blobs.get(`${runId}/${name}`) },
      records: {
        recorded: async (_s, runId, names) =>
          names.flatMap((n) => {
            const r = rows.get(`${runId}/${n}`);
            return r ? [{ name: n, ...r }] : [];
          }),
      },
      attest,
      signer: { signRelease: async () => ({ ok: false, reason: "no_backend" }) as never },
      owner: "lane-2",
      unpackRoot: root,
    });
    await createReleaseRequest(db, a.scope, {
      runId: a.runId,
      tag: "v1.0.0",
      artifacts: ["binaries"],
      requestedBy: "test",
    });
    expect(await refusing.processNext()).toBe(true);
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });
});
