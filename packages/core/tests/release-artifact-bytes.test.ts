// #544 round 2: what a client that co-signs a release reads. The stored bytes of a run's artifact
// (the whole blob, or one file out of its zip) over REST, and the approval a run holds (the
// manifest digest the human approved). Reader and above for the bytes, release_operator for the
// approval, both tenant-scoped.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsArtifactStore } from "../src/artifacts/store";
import { RELEASE_STATEMENT_TYPE, statementHash } from "../src/approvals/statement";
import { canonicalJson } from "../src/audit/chain";
import { insertApprover, insertRecord, listAudit, recordArtifact, type Db } from "../src/db";
import { dispatch, registry } from "../src/ops";
import { createRestApi } from "../src/ops/rest";
import { mcpTools } from "../src/ops/mcp";
import { buildOpenApi } from "../src/ops/openapi";
import { listZipFiles, readZipFile } from "../src/release/unpack";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";
import { buildZip } from "./helpers/zip-builder";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
const tmp = mkdtempSync(join(tmpdir(), "tt-artifact-bytes-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let db: Db;
let a: Tenant;
let b: Tenant;
let dir: string;
let store: FsArtifactStore;
let api: (req: Request) => Promise<Response | undefined>;
let readerA: string;
let readerB: string;
let relopA: string;
let operatorA: string;

const BIN1 = enc("binary one: ".repeat(500));
const BIN2 = enc("binary two");
const MANIFEST = enc('{"version":"1.0.0"}');
const ZIP = buildZip([
  { name: "app-1.0.0-linux-x64", data: BIN1 },
  { name: "app-1.0.0-darwin-arm64", data: BIN2 },
  { name: "manifest.json", data: MANIFEST },
  { name: "dist/nested.txt", data: "nested" },
]);

/** Stores a blob where the artifact store serves it and records the artifact row. */
async function put(t: Tenant, name: string, bytes: Uint8Array, over: { sha256?: string } = {}) {
  mkdirSync(join(dir, t.runId), { recursive: true });
  writeFileSync(join(dir, t.runId, name), bytes);
  await recordArtifact(db, t.scope, {
    runId: t.runId,
    attemptId: t.attemptId,
    name,
    sha256: over.sha256 ?? sha(bytes),
    size: bytes.length,
  });
}

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  dir = mkdtempSync(join(tmp, "store-"));
  store = new FsArtifactStore(dir);
  api = createRestApi({ registry, db, artifactBlobs: store }) as typeof api;
  readerA = (await mintToken(db, a.scope, "reader")).secret;
  readerB = (await mintToken(db, b.scope, "reader")).secret;
  relopA = (await mintToken(db, a.scope, "release_operator")).secret;
  operatorA = (await mintToken(db, a.scope, "operator")).secret;
  await put(a, "release-binaries", ZIP);
  await put(a, "raw-file", enc("one raw file"));
});
afterEach(() => {});

const get = (path: string, token: string) =>
  api(
    new Request(`https://ci.example.test/api/v1${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  )!;
const bytes = async (r: Response | undefined) => new Uint8Array(await r!.arrayBuffer());

describe("one file out of a stored artifact zip", () => {
  test("streams the exact bytes of a file in a multi-file artifact, as an octet stream named by its basename", async () => {
    const r = (await get(
      `/runs/${a.runId}/artifacts/release-binaries/files/app-1.0.0-linux-x64`,
      readerA,
    ))!;
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="app-1.0.0-linux-x64"');
    expect(r.headers.get("content-length")).toBe(String(BIN1.length));
    expect(r.headers.get("x-turntable-untrusted-content")).toBe("true");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await bytes(r)).equals(Buffer.from(BIN1))).toBe(true);

    const m = await get(`/runs/${a.runId}/artifacts/release-binaries/files/manifest.json`, readerA);
    expect(new TextDecoder().decode(await bytes(m))).toBe('{"version":"1.0.0"}');
    // a file below a directory: the path has a slash, the name is the basename
    const n = (await get(
      `/runs/${a.runId}/artifacts/release-binaries/files/dist/nested.txt`,
      readerA,
    ))!;
    expect(n.headers.get("content-disposition")).toBe('attachment; filename="nested.txt"');
    expect(new TextDecoder().decode(await bytes(n))).toBe("nested");
  });

  test("the bytes hash to what the lane would sign (so a client can compare with the approved digest)", async () => {
    const r = await get(
      `/runs/${a.runId}/artifacts/release-binaries/files/app-1.0.0-darwin-arm64`,
      readerA,
    );
    expect(sha(await bytes(r))).toBe(sha(BIN2));
  });

  test("a path that climbs out, is empty, absolute or not plain is refused", async () => {
    for (const bad of [
      "..%2F..%2Fetc%2Fpasswd",
      "dist%2F..%2Fmanifest.json",
      "%2e%2e",
      "%2Fetc%2Fpasswd",
      "a%5Cb",
      ".hidden",
      "dist%2F%2Fnested.txt",
    ]) {
      const r = (await get(`/runs/${a.runId}/artifacts/release-binaries/files/${bad}`, readerA))!;
      expect([400, 404], bad).toContain(r.status);
      expect(r.headers.get("content-type"), bad).toContain("application/json");
    }
    // and nothing outside the zip is reachable by name either
    const miss = (await get(
      `/runs/${a.runId}/artifacts/release-binaries/files/not-there`,
      readerA,
    ))!;
    expect(miss.status).toBe(404);
  });

  test("another org's run is not found, whoever asks, and so is a name that is not recorded", async () => {
    const other = (await get(
      `/runs/${a.runId}/artifacts/release-binaries/files/manifest.json`,
      readerB,
    ))!;
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe("not_found");
    const whole = (await get(`/runs/${a.runId}/artifacts/release-binaries`, readerB))!;
    expect(whole.status).toBe(404);
    expect((await get(`/runs/${a.runId}/artifacts/nope/files/x`, readerA))!.status).toBe(404);
  });

  test("a raw artifact is its own single file; reader is enough, no token is refused", async () => {
    const r = await get(`/runs/${a.runId}/artifacts/raw-file/files/raw-file`, readerA);
    expect(new TextDecoder().decode(await bytes(r))).toBe("one raw file");
    const none = (await api(
      new Request(`https://ci.example.test/api/v1/runs/${a.runId}/artifacts/raw-file`),
    ))!;
    expect(none.status).toBe(401);
  });

  test("bytes that differ from what the build recorded are not served", async () => {
    await put(a, "tampered", enc("recorded as something else"), { sha256: sha("something else") });
    expect((await get(`/runs/${a.runId}/artifacts/tampered`, readerA))!.status).toBe(409);
    expect((await get(`/runs/${a.runId}/artifacts/tampered/files/tampered`, readerA))!.status).toBe(
      409,
    );
  });

  test("a zip with an unsafe entry is refused, not served", async () => {
    await put(a, "evil", buildZip([{ name: "../escape", data: "x" }]));
    const r = (await get(`/runs/${a.runId}/artifacts/evil/files/escape`, readerA))!;
    expect(r.status).toBe(409);
  });
});

describe("the whole stored artifact, and its listing", () => {
  test("streams the zip as stored, and the listing names its files by path and size", async () => {
    const r = (await get(`/runs/${a.runId}/artifacts/release-binaries`, readerA))!;
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="release-binaries"');
    expect(sha(await bytes(r))).toBe(sha(ZIP));

    const l = (await get(`/runs/${a.runId}/artifacts/release-binaries/files`, readerA))!;
    expect(l.headers.get("content-type")).toContain("application/json");
    const body = (await l.json()) as {
      archive: boolean;
      sha256: string;
      files: { path: string; size: number }[];
    };
    expect(body.archive).toBe(true);
    expect(body.sha256).toBe(sha(ZIP));
    expect(body.files).toEqual([
      { path: "app-1.0.0-darwin-arm64", size: BIN2.length },
      { path: "app-1.0.0-linux-x64", size: BIN1.length },
      { path: "dist/nested.txt", size: 6 },
      { path: "manifest.json", size: MANIFEST.length },
    ]);
    const raw = (await (await get(
      `/runs/${a.runId}/artifacts/raw-file/files`,
      readerA,
    ))!.json()) as {
      archive: boolean;
      files: { path: string }[];
    };
    expect(raw).toMatchObject({ archive: false, files: [{ path: "raw-file" }] });
  });

  test("reads are audited, with who and what and never the bytes", async () => {
    await get(`/runs/${a.runId}/artifacts/release-binaries/files/manifest.json`, readerA);
    await get(`/runs/${a.runId}/artifacts/release-binaries`, readerA);
    const rows = (await listAudit(db, a.scope)).filter((x) =>
      ["get_artifact_file", "get_artifact"].includes(x.op),
    );
    expect(rows.map((x) => x.op).toSorted()).toEqual(["get_artifact", "get_artifact_file"]);
    expect(rows.every((x) => x.effect === "read" && x.outcome === "ok")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("version");
  });

  test("with artifacts off the op says so", async () => {
    const off = createRestApi({ registry, db }) as typeof api;
    const r = (await off(
      new Request(`https://ci.example.test/api/v1/runs/${a.runId}/artifacts/release-binaries`, {
        headers: { authorization: `Bearer ${readerA}` },
      }),
    ))!;
    expect(r.status).not.toBe(200);
  });

  test("MCP lists files only: the byte ops are not tools, the listing is", () => {
    const names = mcpTools(registry).map((t) => t.name);
    expect(names).toContain("get_artifact_files");
    expect(names).not.toContain("get_artifact_file");
    expect(names).not.toContain("get_artifact");
    expect(names).not.toContain("get_release_approval");
  });

  test("the OpenAPI document describes the downloads as octet streams", () => {
    const doc = buildOpenApi(registry, "test") as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content: Record<string, unknown> }> }>
      >;
    };
    for (const p of [
      "/runs/{run_id}/artifacts/{name}",
      "/runs/{run_id}/artifacts/{name}/files/{path}",
    ]) {
      const ok =
        doc.paths[`/api/v1${p}`]?.get?.responses["200"] ?? doc.paths[p]?.get?.responses["200"];
      expect(Object.keys(ok!.content), p).toEqual(["application/octet-stream"]);
    }
  });
});

describe("the zip reader behind it", () => {
  test("reads one entry by name with every check, and nothing for a name that is not there", () => {
    expect(listZipFiles(ZIP).map((f) => f.name)).toContain("manifest.json");
    expect(Buffer.from(readZipFile(ZIP, "manifest.json")!).equals(Buffer.from(MANIFEST))).toBe(
      true,
    );
    expect(readZipFile(ZIP, "missing")).toBeUndefined();
    // a corrupt CRC is refused, as the unpacker does
    const bad = Buffer.from(buildZip([{ name: "f", data: "hello", crc: 1 }]));
    expect(() => readZipFile(bad, "f")).toThrow(/CRC/);
    // a file over the cap is refused before it is inflated
    expect(() => readZipFile(ZIP, "app-1.0.0-linux-x64", { maxFileBytes: 10 })).toThrow(
      /too_large/,
    );
  });
});

describe("get_release_approval", () => {
  const stmt = (over: Record<string, unknown> = {}) => ({
    type: RELEASE_STATEMENT_TYPE,
    org: a.slug,
    project: a.projectSlug,
    run_id: a.runId,
    head_sha: "a".repeat(40),
    workflow_hash: "b".repeat(64),
    environment: "release",
    manifest_sha256: sha("the manifest"),
    lane_config_version: 7,
    approver: "approver-1",
    expires_at: Date.now() + 3_600_000,
    nonce: "n".repeat(20),
    ...over,
  });
  async function approve(t: Tenant, statement: Record<string, unknown>, person = "alice") {
    const text = canonicalJson(statement);
    const approver = await insertApprover(
      db,
      t.orgId,
      {
        person,
        forgeLogin: person,
        kind: "ed25519",
        publicKey: "AAAA",
        alg: "EdDSA",
        createdBy: "test",
      },
      Date.now(),
    );
    await insertRecord(
      db,
      t.orgId,
      {
        projectId: t.projectId,
        kind: "environment",
        runId: t.runId,
        environment: "release",
        statementHash: statementHash(statement as never),
        statement: text,
        method: "ed25519",
        approverId: approver.id,
        person,
        signature: "sig",
        expiresAt: Date.now() + 3_600_000,
      },
      Date.now(),
    );
  }
  const ask = (token: string, runId = a.runId) =>
    dispatch({ registry, db }, { kind: "bearer", token }, "get_release_approval", {
      run_id: runId,
    });

  test("before any approval: not approved, nothing bound", async () => {
    const r = await ask(relopA);
    expect(r.ok && r.output).toMatchObject({
      approved: false,
      environment: "release",
      manifest_sha256: null,
      lane_config_version: null,
      approved_at: null,
      statement_hash: null,
    });
  });

  test("after the approval: the manifest digest, the lane config version, when, and the statement hash", async () => {
    const s = stmt();
    await approve(a, s);
    const r = await ask(relopA);
    const out = r.ok && (r.output as Record<string, unknown>);
    expect(out).toMatchObject({
      approved: true,
      manifest_sha256: sha("the manifest"),
      lane_config_version: 7,
      statement_hash: statementHash(s as never),
    });
    expect(typeof (out as { approved_at: string }).approved_at).toBe("string");
    expect((out as { approvals: unknown[] }).approvals).toHaveLength(1);
  });

  test("release_operator and above only; a reader and an operator are refused; another org's run is not found", async () => {
    await approve(a, stmt());
    expect((await ask(readerA)).ok).toBe(false);
    expect((await ask(operatorA)).ok).toBe(false);
    const other = await ask(relopA, "nope");
    expect(!other.ok && other.error.code).toBe("not_found");
    const relopB = (await mintToken(db, b.scope, "release_operator")).secret;
    const cross = await ask(relopB, a.runId);
    expect(!cross.ok && cross.error.code).toBe("not_found");
  });

  test("a statement naming another run does not count for this one", async () => {
    await approve(a, stmt({ run_id: "someone-elses-run" }));
    const r = await ask(relopA);
    expect(r.ok && (r.output as { approved: boolean }).approved).toBe(false);
  });
});
