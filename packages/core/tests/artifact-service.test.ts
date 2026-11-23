// The artifact service (#340): what actions/upload-artifact and download-artifact reach. The
// client in here sends what @actions/artifact 6.3.1 sends, the version inside the releases
// release.yml pins (upload-artifact v7.0.2, download-artifact v8.0.2): twirp JSON calls
// (camelCase fields, bare strings for the wrapper types, `version: 7`, a `mimeType`) with the
// runtime token as a bearer, then Azure block-blob requests (Put Block, Put Block List) to the
// signed URL, and for a download a GET that decides zip or raw by Content-Type and checks the
// `digest` ListArtifacts reported.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ArtifactGrants } from "../src/artifacts/grants";
import { jobArtifactProvider } from "../src/artifacts/job";
import {
  createArtifactService,
  TWIRP_PREFIX,
  type ArtifactService,
} from "../src/artifacts/service";
import { FsArtifactStore } from "../src/artifacts/store";
import { dirArtifacts } from "../src/release/artifacts";
import {
  createAttempt,
  createJob,
  createRun,
  type Db,
  listRunArtifacts,
  setOrgQuotas,
} from "../src/db";
import * as s from "../src/db/schema";
import type { TrustClass } from "../src/trust";
import { seedWorld, type Tenant } from "./ops-helpers";

const BASE = "http://control.test";
const sha = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

let db: Db;
let a: Tenant;
let b: Tenant;
let dir: string;
let svc: ArtifactService;
let notices: string[];
let clock: number;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  dir = mkdtempSync(join(tmpdir(), "tt-artifacts-"));
  notices = [];
  clock = Date.now();
  svc = make();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(o: { max?: number; retentionMs?: number } = {}): ArtifactService {
  return createArtifactService({
    db,
    store: new FsArtifactStore(dir),
    grants: new ArtifactGrants(),
    maxArtifactBytes: o.max ?? 1024 * 1024,
    baseUrl: BASE,
    ...(o.retentionMs === undefined ? {} : { retentionMs: o.retentionMs }),
    onNotice: (_g, m) => notices.push(m),
    now: () => clock,
  });
}

type Job = { runId: string; attemptId: string; scope: Tenant["scope"]; token: string };

/** A run with one attempt, and a grant for it as the scheduler would issue. */
async function job(
  t: Tenant,
  klass: TrustClass,
  opts: {
    jobClass?: TrustClass;
    attemptClass?: TrustClass;
    runId?: string;
    service?: ArtifactService;
  } = {},
): Promise<Job> {
  const scope = t.scope;
  const run = await createRun(db, scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    trust: JSON.stringify({
      class: klass,
      reasons: [],
      facts: {},
      workflowHash: "h",
      decidedAt: 1,
    }),
  });
  return attach(t, run.id, opts.jobClass ?? klass, opts.attemptClass ?? klass, opts.service);
}

/** Another job (attempt) of an existing run. */
async function attach(
  t: Tenant,
  runId: string,
  jobClass: TrustClass,
  attemptClass: TrustClass,
  service: ArtifactService = svc,
): Promise<Job> {
  const scope = t.scope;
  const j = (await createJob(db, scope, {
    runId,
    jobKey: `j${Math.random().toString(36).slice(2)}`,
    name: "j",
  }))!;
  const at = (await createAttempt(db, scope, { jobId: j.id, provider: "test" }))!;
  await db.run((h) =>
    h.orm
      .update(s.jobAttempts)
      .set({ trustClass: attemptClass })
      .where(eq(s.jobAttempts.id, at.id)),
  );
  const grant = jobArtifactProvider(service)({
    runId,
    attemptId: at.id,
    scope,
    klass: jobClass,
    egress: "open",
    local: false,
  })!;
  return { runId, attemptId: at.id, scope, token: grant.token };
}

const rpc = async (
  token: string,
  method: string,
  body: unknown,
  service: ArtifactService = svc,
): Promise<{ status: number; body: any }> => {
  const res = (await service.handle(
    new Request(`${BASE}${TWIRP_PREFIX}${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: await res.json() };
};

const put = async (url: string, body: string | Uint8Array, service: ArtifactService = svc) =>
  (await service.handle(new Request(url, { method: "PUT", body })))!;

const blockId = (n: number): string => Buffer.from(String(n).padStart(6, "0")).toString("base64");
const blockList = (ids: string[]): string =>
  `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((i) => `<Latest>${i}</Latest>`).join("")}</BlockList>`;

/** The run and job ids the client reads from the token's `scp` claim (getBackendIdsFromToken). */
const backendIds = (token: string) => {
  const scp = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).scp as string;
  const [, workflowRunBackendId, workflowJobRunBackendId] = scp.split(":");
  return { workflowRunBackendId, workflowJobRunBackendId };
};

/**
 * What upload-artifact does: create, stage blocks, commit the list, finalize. `raw` is v7's
 * `archive: false`: one file under its own name, with the mime type of that file.
 */
async function upload(
  j: Job,
  name: string,
  blocks: (string | Uint8Array)[],
  o: { hash?: string; size?: number; raw?: boolean } = {},
  service: ArtifactService = svc,
) {
  const ids6 = backendIds(j.token);
  const created = await rpc(
    j.token,
    "CreateArtifact",
    {
      ...ids6,
      name,
      mimeType: o.raw ? "application/octet-stream" : "application/zip",
      version: 7,
    },
    service,
  );
  if (created.status !== 200) return { created };
  const url = created.body.signed_upload_url as string;
  const ids: string[] = [];
  for (const [i, bytes] of blocks.entries()) {
    const id = blockId(i);
    ids.push(id);
    const r = await put(`${url}?comp=block&blockid=${encodeURIComponent(id)}`, bytes, service);
    if (r.status !== 201) return { created, block: r };
  }
  const all = Buffer.concat(blocks.map((x) => Buffer.from(x)));
  const list = await put(`${url}?comp=blocklist`, blockList(ids), service);
  const fin =
    list.status === 201
      ? await rpc(
          j.token,
          "FinalizeArtifact",
          {
            ...ids6,
            name,
            size: String(o.size ?? all.length),
            hash: o.hash ?? `sha256:${sha(all)}`,
          },
          service,
        )
      : undefined;
  return { created, list, fin, all };
}

const list = (j: Job, filter?: string) =>
  rpc(j.token, "ListArtifacts", {
    ...backendIds(j.token),
    ...(filter === undefined ? {} : { nameFilter: filter }),
  });

async function download(j: Job, name: string): Promise<Response | undefined> {
  const r = await rpc(j.token, "GetSignedArtifactURL", { ...backendIds(j.token), name });
  if (r.status !== 200) return undefined;
  return (await svc.handle(new Request(r.body.signed_url)))!;
}

describe("upload and download", () => {
  test("blocks upload, finalize records the artifact, and the same run reads it back", async () => {
    const j = await job(a, "protected");
    const zip = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8]);
    const up = await upload(j, "dist", [zip.slice(0, 5), zip.slice(5)]);
    expect(up.fin?.status).toBe(200);
    expect(Number(up.fin?.body.artifact_id)).toBeGreaterThan(0);

    const [row] = await listRunArtifacts(db, j.scope, j.runId);
    expect(row).toMatchObject({
      name: "dist",
      sha256: sha(zip),
      size: zip.length,
      klass: "protected",
      digestSource: "computed",
      attemptId: j.attemptId,
    });

    // A later job of the same run lists it and downloads exactly the bytes.
    const later = await attach(a, j.runId, "protected", "protected");
    const l = await list(later);
    expect(l.body.artifacts.map((x: any) => x.name)).toEqual(["dist"]);
    expect(l.body.artifacts[0].database_id).toBe(up.fin?.body.artifact_id);
    const res = await download(later, "dist");
    expect(res?.status).toBe(200);
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(zip);
  });

  test("a single Put Blob upload works too", async () => {
    const j = await job(a, "protected");
    const created = await rpc(j.token, "CreateArtifact", { name: "one.zip" });
    const bytes = "single request bytes";
    expect((await put(created.body.signed_upload_url, bytes)).status).toBe(201);
    const fin = await rpc(j.token, "FinalizeArtifact", {
      name: "one.zip",
      size: String(bytes.length),
      hash: { value: `sha256:${sha(bytes)}` },
    });
    expect(fin.status).toBe(200);
    expect((await listRunArtifacts(db, j.scope, j.runId))[0]?.sha256).toBe(sha(bytes));
  });

  test("the stored layout is the one the release lane reads", async () => {
    const j = await job(a, "release");
    await upload(j, "app.zip", ["release bytes"]);
    const read = await dirArtifacts(dir).read(j.runId, "app.zip");
    expect(Buffer.from(read!).toString()).toBe("release bytes");
  });

  test("a name is recorded once per run", async () => {
    const j = await job(a, "protected");
    await upload(j, "dist", ["x"]);
    const again = await rpc(j.token, "CreateArtifact", { name: "dist" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_exists");
    expect((await rpc(j.token, "DeleteArtifact", { name: "dist" })).status).toBe(501);
  });

  test("names that are not one plain component are refused", async () => {
    const j = await job(a, "protected");
    for (const name of ["", "../x", "a/b", ".hidden", "x".repeat(201)])
      expect((await rpc(j.token, "CreateArtifact", { name })).status).toBe(400);
  });
});

describe("scope", () => {
  test("another run in the same project cannot read it, and the run id in a request is ignored", async () => {
    const j = await job(a, "protected");
    await upload(j, "dist", ["secret build"]);
    const other = await job(a, "protected");
    const forged = await rpc(other.token, "ListArtifacts", {
      workflow_run_backend_id: j.runId,
      workflowRunBackendId: j.runId,
    });
    expect(forged.body.artifacts).toEqual([]);
    expect(
      (
        await rpc(other.token, "GetSignedArtifactURL", {
          name: "dist",
          workflow_run_backend_id: j.runId,
        })
      ).status,
    ).toBe(404);
    // Even handed the other run's blob URL, the job's own grant decides the run.
    const url = (await rpc(j.token, "GetSignedArtifactURL", { name: "dist" })).body
      .signed_url as string;
    const swapped = url.replace(j.token, other.token);
    expect((await svc.handle(new Request(swapped)))!.status).toBe(404);
  });

  test("another project and another org cannot read it", async () => {
    const j = await job(a, "protected");
    await upload(j, "dist", ["x"]);
    for (const t of [b]) {
      const o = await job(t, "protected");
      expect((await list(o)).body.artifacts).toEqual([]);
      expect(await download(o, "dist")).toBeUndefined();
    }
    // A second project of the same org.
    const { createProject } = await import("../src/db");
    const p2 = await createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
    const t2: Tenant = { ...a, projectId: p2.id, scope: { orgId: a.orgId, projectId: p2.id } };
    const o2 = await job(t2, "protected");
    expect((await list(o2)).body.artifacts).toEqual([]);
    expect(await download(o2, "dist")).toBeUndefined();
  });

  test("an upload URL works only for the attempt that created it", async () => {
    const j = await job(a, "protected");
    const other = await attach(a, j.runId, "protected", "protected");
    const created = await rpc(j.token, "CreateArtifact", { name: "x" });
    const stolen = (created.body.signed_upload_url as string).replace(j.token, other.token);
    expect((await put(`${stolen}?comp=block&blockid=AAAA`, "x")).status).toBe(404);
  });

  test("bad, revoked and ended-job tokens are all unauthorized", async () => {
    const j = await job(a, "protected");
    expect((await rpc("not.a.token", "ListArtifacts", {})).status).toBe(401);
    const u = (await rpc(j.token, "CreateArtifact", { name: "x" })).body
      .signed_upload_url as string;
    svc.grants.revoke(j.attemptId);
    expect((await rpc(j.token, "ListArtifacts", {})).status).toBe(401);
    expect((await put(`${u}?comp=block&blockid=AAAA`, "x")).status).toBe(401);
    expect(await svc.handle(new Request(`${BASE}/other`))).toBeUndefined();
  });

  test("the token reads as a JWT with the run and attempt in scp", async () => {
    const j = await job(a, "protected");
    const claims = JSON.parse(Buffer.from(j.token.split(".")[1]!, "base64url").toString());
    expect(claims.scp).toBe(`Actions.Results:${j.runId}:${j.attemptId}`);
  });

  test("no grant for a job without a network path or a local run", async () => {
    const p = jobArtifactProvider(svc);
    const req = {
      runId: "r",
      attemptId: "t",
      scope: a.scope,
      klass: "protected" as const,
      local: false,
    };
    expect(p({ ...req, egress: "none" })).toBeUndefined();
    expect(p({ ...req, egress: "open", local: true })).toBeUndefined();
  });
});

describe("trust classes", () => {
  test("a release job cannot list or download what a lower class wrote", async () => {
    // One run; the attempt that wrote it ran as untrusted_pr, the reader runs as release.
    const writer = await job(a, "release", { attemptClass: "untrusted_pr" });
    await upload(writer, "dist", ["from a low class"]);
    const [row] = await listRunArtifacts(db, writer.scope, writer.runId);
    expect(row?.klass).toBe("untrusted_pr");

    const reader = await attach(a, writer.runId, "release", "release");
    expect((await list(reader)).body.artifacts).toEqual([]);
    expect(await download(reader, "dist")).toBeUndefined();
    expect(notices.some((n) => n.includes("release build consumes nothing below"))).toBe(true);

    // The blob URL, had the job obtained one, is refused on its own.
    const direct = `${BASE}/_artifacts/${reader.token}/download/dist`;
    expect((await svc.handle(new Request(direct)))!.status).toBe(404);
  });

  test("a lower class reader needs an explicit request, which the artifact actions cannot make", async () => {
    const writer = await job(a, "untrusted_pr");
    await upload(writer, "dist", ["x"]);
    const reader = await attach(a, writer.runId, "protected", "protected");
    expect((await list(reader)).body.artifacts).toEqual([]);
    expect(await download(reader, "dist")).toBeUndefined();
    // The same class, and a higher one, read it.
    const peer = await attach(a, writer.runId, "untrusted_pr", "untrusted_pr");
    expect((await list(peer)).body.artifacts.length).toBe(1);
  });

  test("a release class artifact is read by a release job", async () => {
    const w = await job(a, "release");
    await upload(w, "dist", ["ok"]);
    const r = await attach(a, w.runId, "release", "release");
    expect((await download(r, "dist"))?.status).toBe(200);
  });
});

describe("integrity", () => {
  test("a reported hash that does not match the bytes is refused and nothing is recorded", async () => {
    const j = await job(a, "protected");
    const up = await upload(j, "dist", ["real bytes"], { hash: `sha256:${sha("other bytes")}` });
    expect(up.fin?.status).toBe(400);
    expect(await listRunArtifacts(db, j.scope, j.runId)).toEqual([]);
    expect(existsSync(join(dir, j.runId, "dist"))).toBe(false);
    // The name is free again.
    expect((await upload(j, "dist", ["real bytes"])).fin?.status).toBe(200);
  });

  test("a reported size that does not match is refused", async () => {
    const j = await job(a, "protected");
    const up = await upload(j, "dist", ["12345"], { size: 99 });
    expect(up.fin?.status).toBe(400);
    expect(await listRunArtifacts(db, j.scope, j.runId)).toEqual([]);
  });

  test("finalize without a committed upload is refused", async () => {
    const j = await job(a, "protected");
    await rpc(j.token, "CreateArtifact", { name: "dist" });
    expect((await rpc(j.token, "FinalizeArtifact", { name: "dist" })).status).toBe(412);
  });

  test("bytes changed on disk after recording are not served", async () => {
    const j = await job(a, "protected");
    await upload(j, "dist", ["original"]);
    writeFileSync(join(dir, j.runId, "dist"), "tampered");
    const res = await download(j, "dist");
    expect(res?.status).toBe(500);
    expect(await res!.text()).not.toContain("tampered");
    expect(notices.some((n) => n.includes("do not match the recorded digest"))).toBe(true);
  });
});

describe("limits", () => {
  test("an artifact over the per-artifact cap is refused and leaves nothing", async () => {
    svc = make({ max: 10 });
    const j = await job(a, "protected", { service: svc });
    const up = await upload(j, "big", ["0123456789", "x"], {}, svc);
    expect(up.block?.status).toBe(413);
    expect(await listRunArtifacts(db, j.scope, j.runId)).toEqual([]);
  });

  test("the org's stored-bytes quota caps an upload", async () => {
    await setOrgQuotas(db, a.orgId, { maxStoredBytes: 100 }, "test", 1);
    const j = await job(a, "protected");
    expect((await upload(j, "one", ["x".repeat(60)])).fin?.status).toBe(200);
    // 40 bytes of room are left, so a 60-byte block is refused.
    const over = await upload(j, "two", ["x".repeat(60)]);
    expect(over.block?.status).toBe(413);
    expect((await listRunArtifacts(db, j.scope, j.runId)).map((r) => r.name)).toEqual(["one"]);
    // What fits still goes in.
    expect((await upload(j, "three", ["x".repeat(40)])).fin?.status).toBe(200);
    // And a full org is refused at the start.
    const full = await rpc(j.token, "CreateArtifact", { name: "four" });
    expect(full.status).toBe(413);
    expect(full.body.code).toBe("resource_exhausted");
  });

  test("another org's quota does not apply", async () => {
    await setOrgQuotas(db, a.orgId, { maxStoredBytes: 1 }, "test", 1);
    const j = await job(b, "protected");
    expect((await upload(j, "big", ["x".repeat(500)])).fin?.status).toBe(200);
  });
});

describe("retention and sweep", () => {
  test("a blob past retention is not served and is swept", async () => {
    svc = make({ retentionMs: 1000 });
    const j = await job(a, "protected", { service: svc });
    await upload(j, "dist", ["old"], {}, svc);
    const path = join(dir, j.runId, "dist");
    expect(readFileSync(path, "utf8")).toBe("old");
    clock += 5000;
    const t = (clock - 10_000) / 1000;
    utimesSync(path, t, t);
    // Reads are refused by age as well as by the sweep.
    const r = await rpc(j.token, "ListArtifacts", {}, svc);
    expect(r.body.artifacts).toEqual([]);
    await svc.sweep();
    expect(existsSync(path)).toBe(false);
    // The recorded digest stays.
    expect((await listRunArtifacts(db, j.scope, j.runId))[0]?.sha256).toBe(sha("old"));
  });

  test("an abandoned upload is dropped", async () => {
    const j = await job(a, "protected");
    const created = await rpc(j.token, "CreateArtifact", { name: "x" });
    await put(`${created.body.signed_upload_url}?comp=block&blockid=AAAA`, "partial");
    clock += 2 * 3600_000;
    await svc.sweep();
    const r = await put(`${created.body.signed_upload_url}?comp=block&blockid=AAAA`, "more");
    expect(r.status).toBe(404);
  });
});

describe("the control-plane server", () => {
  test("serves the twirp API at the root of the origin, where the client sends it", async () => {
    const { startServer } = await import("../src/server");
    const server = startServer({ port: 0, host: "127.0.0.1", db, artifacts: svc });
    try {
      const j = await job(a, "protected");
      const res = await fetch(`http://127.0.0.1:${server.port}${TWIRP_PREFIX}ListArtifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${j.token}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ artifacts: [] });
      const anon = await fetch(`http://127.0.0.1:${server.port}${TWIRP_PREFIX}ListArtifacts`, {
        method: "POST",
        body: "{}",
      });
      expect(anon.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });
});

describe("what @actions/artifact 6.3.1 (upload-artifact v7, download-artifact v8) adds", () => {
  const ZIP = new Uint8Array([80, 75, 3, 4, 9, 9, 9, 9, 9, 9]);

  test("a zip is served as application/zip, and ListArtifacts reports the digest the client checks", async () => {
    const j = await job(a, "protected");
    await upload(j, "dist", [ZIP]);
    const l = await list(await attach(a, j.runId, "protected", "protected"), "dist");
    expect(l.body.artifacts).toHaveLength(1);
    // A bare string, which is how a StringValue is written in JSON.
    expect(l.body.artifacts[0].digest).toBe(`sha256:${sha(ZIP)}`);
    const later = await attach(a, j.runId, "protected", "protected");
    const res = await download(later, "dist");
    expect(res?.headers.get("content-type")).toBe("application/zip");
    expect(sha(new Uint8Array(await res!.arrayBuffer()))).toBe(
      l.body.artifacts[0].digest.slice("sha256:".length),
    );
  });

  test("archive: false uploads one raw file: it is served as octet-stream, named by Content-Disposition", async () => {
    const j = await job(a, "release");
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
    const up = await upload(j, "turntable-linux-x64", [elf], { raw: true });
    expect(up.fin?.status).toBe(200);
    const later = await attach(a, j.runId, "release", "release");
    const res = await download(later, "turntable-linux-x64");
    expect(res?.headers.get("content-type")).toBe("application/octet-stream");
    expect(res?.headers.get("content-disposition")).toBe(
      'attachment; filename="turntable-linux-x64"',
    );
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(elf);
    // The release lane reads the same stored bytes.
    expect(Buffer.from((await dirArtifacts(dir).read(j.runId, "turntable-linux-x64"))!)).toEqual(
      Buffer.from(elf),
    );
  });

  test("the client's mimeType is never echoed: a raw file claiming application/zip is still octet-stream", async () => {
    const j = await job(a, "protected");
    const ids = backendIds(j.token);
    const created = await rpc(j.token, "CreateArtifact", {
      ...ids,
      name: "liar",
      mimeType: "application/zip",
      version: 7,
    });
    const bytes = "not a zip at all";
    expect((await put(created.body.signed_upload_url, bytes)).status).toBe(201);
    expect(
      (
        await rpc(j.token, "FinalizeArtifact", {
          ...ids,
          name: "liar",
          size: String(bytes.length),
          hash: `sha256:${sha(bytes)}`,
        })
      ).status,
    ).toBe(200);
    const res = await download(await attach(a, j.runId, "protected", "protected"), "liar");
    expect(res?.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("a reported hash is compared (as the bare string 6.x sends), and a wrong one refuses the upload", async () => {
    const j = await job(a, "protected");
    const up = await upload(j, "dist", ["bytes"], { hash: `sha256:${"0".repeat(64)}` });
    expect(up.fin?.status).toBe(400);
    expect(await listRunArtifacts(db, j.scope, j.runId)).toEqual([]);
  });

  test("download-artifact by id: ListArtifacts takes idFilter as a bare string", async () => {
    const j = await job(a, "protected");
    const up = await upload(j, "dist", [ZIP]);
    const later = await attach(a, j.runId, "protected", "protected");
    const byId = await rpc(later.token, "ListArtifacts", {
      ...backendIds(later.token),
      idFilter: up.fin?.body.artifact_id,
    });
    expect(byId.body.artifacts.map((x: any) => x.name)).toEqual(["dist"]);
    const none = await rpc(later.token, "ListArtifacts", {
      ...backendIds(later.token),
      idFilter: "1",
    });
    expect(none.body.artifacts).toEqual([]);
  });
});

describe("an upload-only grant", () => {
  async function uploadOnly(t: Tenant, runId?: string): Promise<Job> {
    const j = await job(t, "release");
    const at = runId ? await attach(t, runId, "release", "release") : j;
    const token = svc.grants.issue({
      attemptId: at.attemptId,
      runId: at.runId,
      scope: at.scope,
      klass: "release",
      mode: "upload",
    });
    return { ...at, token };
  }

  test("uploads its own artifact end to end", async () => {
    const j = await uploadOnly(a);
    const up = await upload(j, "dist", ["upload only bytes"]);
    expect(up.fin?.status).toBe(200);
    expect((await listRunArtifacts(db, j.scope, j.runId))[0]).toMatchObject({
      name: "dist",
      sha256: sha("upload only bytes"),
    });
  });

  test("cannot list, ask for a download URL, delete or download, not even its own artifact", async () => {
    const j = await uploadOnly(a);
    await upload(j, "dist", ["x"]);
    for (const method of ["ListArtifacts", "GetSignedArtifactURL", "DeleteArtifact"]) {
      const r = await rpc(j.token, method, { ...backendIds(j.token), name: "dist" });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("permission_denied");
    }
    // A download URL minted by a full grant of the same attempt does not work with this token.
    const full = svc.grants.issue({
      attemptId: j.attemptId,
      runId: j.runId,
      scope: j.scope,
      klass: "release",
    });
    const url = (await rpc(full, "GetSignedArtifactURL", { name: "dist" })).body
      .signed_url as string;
    // issuing a grant replaced the upload one: re-issue it, then try the URL with it swapped in.
    const upOnly = svc.grants.issue({
      attemptId: j.attemptId,
      runId: j.runId,
      scope: j.scope,
      klass: "release",
      mode: "upload",
    });
    const res = await svc.handle(new Request(url.replace(full, upOnly)));
    expect(res!.status).toBe(403);
    expect(await res!.text()).toBe("this credential can only upload");
  });

  test("is short-lived and ends with the attempt", async () => {
    const grants = new ArtifactGrants({ now: () => clock });
    const t = grants.issue({
      attemptId: "at1",
      runId: "r1",
      scope: a.scope,
      klass: "release",
      mode: "upload",
    });
    expect(grants.verify(t)?.mode).toBe("upload");
    clock += 2 * 3600_000 + 1;
    expect(grants.verify(t)).toBeUndefined();
    const full = grants.issue({ attemptId: "at2", runId: "r1", scope: a.scope, klass: "release" });
    clock += 2 * 3600_000 + 1;
    expect(grants.verify(full)?.mode).toBe("full");
  });
});
