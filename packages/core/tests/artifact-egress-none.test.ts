// A job with egress none still uploads artifacts: the artifact service is Turntable itself, and
// the one way to it is the proxy's upload-only route (proxy/index.ts, artifactRules) with an
// upload-only credential. These drive that route with the requests upload-artifact 6.x sends,
// through a real proxy, and check everything else stays shut.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { plannedArtifactUpload } from "@turntable/act-runner";
import { eq } from "drizzle-orm";
import { ArtifactGrants } from "../src/artifacts/grants";
import { jobArtifactProvider } from "../src/artifacts/job";
import {
  createArtifactService,
  TWIRP_PREFIX,
  type ArtifactService,
} from "../src/artifacts/service";
import { FsArtifactStore } from "../src/artifacts/store";
import { type Db, listRunArtifacts } from "../src/db";
import { getAttempt, getJob, getRun } from "../src/db/repos";
import * as s from "../src/db/schema";
import { artifactRules, artifactTargetOf, SecretsProxy, withSecretsProxy } from "../src/proxy";
import { SecretVault } from "../src/secrets/vault";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";
import { seedWorld, type Tenant } from "./ops-helpers";

const BASE = "https://control.example.test";
const HOST = "control.example.test";
let db: Db;
let a: Tenant;
let dir: string;
let svc: ArtifactService;
let proxy: SecretsProxy;
let upstreamSaw: string[];

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  dir = mkdtempSync(join(tmpdir(), "tt-art-none-"));
  svc = createArtifactService({
    db,
    store: new FsArtifactStore(dir),
    grants: new ArtifactGrants(),
    maxArtifactBytes: 1024 * 1024,
    baseUrl: BASE,
  });
  upstreamSaw = [];
  proxy = await SecretsProxy.start({
    db,
    vault: new SecretVault({ db, masterKey: randomBytes(32) }),
    bindHost: "127.0.0.1",
    // What the proxy's upstream reaches: the control plane's own handler, in process.
    upstream: async (input, init) => {
      const req = new Request(input as string, init);
      upstreamSaw.push(`${req.method} ${new URL(req.url).pathname}`);
      return (await svc.handle(req)) ?? new Response("no", { status: 404 });
    },
    tunnel: async () => {
      throw new Error("no passthrough here");
    },
  });
  await db.orm
    .update(s.runs)
    .set({ trust: JSON.stringify({ class: "release", workflowHash: "h" }), plan: null })
    .where(eq(s.runs.id, a.runId));
  await db.orm
    .update(s.jobAttempts)
    .set({ state: "running", trustClass: "release" })
    .where(eq(s.jobAttempts.id, a.attemptId));
});
afterEach(async () => {
  await proxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const planned = (uploads: boolean) =>
  db.orm
    .update(s.jobs)
    .set({ planned: JSON.stringify({ id: "build", ...(uploads ? { artifactUpload: true } : {}) }) })
    .where(eq(s.jobs.id, a.jobId));

async function ctxOf(): Promise<AttemptContext> {
  return {
    run: (await getRun(db, a.scope, a.runId))!,
    job: (await getJob(db, a.scope, a.jobId))!,
    attempt: (await getAttempt(db, a.scope, a.attemptId))!,
    scope: a.scope,
    provider: {} as AttemptContext["provider"],
    signal: new AbortController().signal,
    store: {} as AttemptContext["store"],
  };
}

const done: AttemptOutcome = { state: "success", reason: "ok" };
const wrap = (inner: (c: AttemptContext) => Promise<AttemptOutcome>) =>
  withSecretsProxy(inner, { proxy, artifacts: () => artifactTargetOf(svc.resultsUrl) });

type Cred = NonNullable<AttemptContext["proxy"]>["credential"];
const basic = (c: Cred): string => Buffer.from(`${c.username}:${c.password}`).toString("base64");

/** CONNECT through the proxy: the status line the proxy answers, and the open socket on 200. */
async function connect(
  c: Cred,
  host: string,
  port: number,
): Promise<{ status: number; sock: net.Socket }> {
  const raw = net.connect(proxy.port, "127.0.0.1");
  await new Promise<void>((r) => raw.once("connect", () => r()));
  raw.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${basic(c)}\r\n\r\n`,
  );
  const head = await new Promise<string>((r) => raw.once("data", (d) => r(d.toString())));
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]), sock: raw };
}

/** One HTTPS request to the control plane through the proxy, as the job's client would. */
async function https(
  c: Cred,
  method: string,
  path: string,
  o: { token?: string; body?: string; host?: string } = {},
): Promise<{ status: number; text: string }> {
  const host = o.host ?? HOST;
  const { status, sock } = await connect(c, host, 443);
  if (status !== 200) {
    sock.destroy();
    return { status, text: "" };
  }
  const secure = tls.connect({ socket: sock, servername: host, ca: c.caPem });
  await new Promise<void>((r) => secure.once("secureConnect", () => r()));
  const body = o.body ?? "";
  secure.write(
    `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n` +
      (o.token ? `Authorization: Bearer ${o.token}\r\n` : "") +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  const chunks: Buffer[] = [];
  for await (const d of secure) chunks.push(d as Buffer);
  const text = Buffer.concat(chunks).toString();
  return {
    status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]),
    text: text.split("\r\n\r\n")[1] ?? "",
  };
}

const twirp = (m: string) => `${TWIRP_PREFIX}${m}`;
const blobPath = (url: string): string => new URL(url).pathname;

/** The upload-only credential the scheduler gives such a job. */
function grant(): string {
  const g = jobArtifactProvider(svc)({
    runId: a.runId,
    attemptId: a.attemptId,
    scope: a.scope,
    klass: "release",
    egress: "none",
    proxyRoute: true,
    local: false,
  });
  return g!.token;
}

describe("the route exists only for a job that uploads", () => {
  test("a job whose plan has no upload-artifact step gets no proxy at all", async () => {
    await planned(false);
    let seen: AttemptContext | undefined;
    await wrap(async (c) => ((seen = c), done))(await ctxOf());
    expect(seen?.proxy).toBeUndefined();
    expect(proxy.active).toBe(0);
  });

  test("a job with one gets a proxy whose rules are the upload endpoints and the attempt is revoked after", async () => {
    await planned(true);
    let seen: AttemptContext | undefined;
    await wrap(async (c) => ((seen = c), done))(await ctxOf());
    expect(seen?.proxy?.artifactUpload).toBe(true);
    // A secret-free job: nothing here is secret-bearing.
    expect(seen?.proxy?.vaultRules).toBe(false);
    expect(proxy.active).toBe(0);
  });

  test("the plan knows: an upload-artifact step of any ref, nothing else", () => {
    expect(plannedArtifactUpload(JSON.stringify({ artifactUpload: true }))).toBe(true);
    expect(plannedArtifactUpload(JSON.stringify({ id: "x" }))).toBe(false);
    expect(plannedArtifactUpload(null)).toBe(false);
    expect(plannedArtifactUpload("not json")).toBe(false);
  });

  test("no https base URL, no route", () => {
    expect(artifactTargetOf("http://control.test")).toBeUndefined();
    expect(artifactTargetOf("nope")).toBeUndefined();
    expect(artifactTargetOf("https://Control.Example.test:8443/x")).toEqual({
      host: "control.example.test",
      port: 8443,
    });
  });

  test("the rules name only POST create and finalize and PUT upload", () => {
    const rules = artifactRules({ host: HOST, port: 443 });
    expect(rules.map((r) => [r.id, r.methods.join(","), r.pathShape ?? r.pathPrefix])).toEqual([
      ["artifact-create", "POST", `${TWIRP_PREFIX}CreateArtifact`],
      ["artifact-finalize", "POST", `${TWIRP_PREFIX}FinalizeArtifact`],
      ["artifact-blob-put", "PUT", "/_artifacts/*/upload/*"],
    ]);
  });
});

describe("egress none, with the upload route", () => {
  test("a v7 upload goes through the proxy end to end: create, put block, block list, finalize", async () => {
    await planned(true);
    const token = grant();
    let artifact: string[] = [];
    await wrap(async (c) => {
      const cred = c.proxy!.credential;
      const ids = { workflowRunBackendId: a.runId, workflowJobRunBackendId: a.attemptId };
      const created = await https(cred, "POST", twirp("CreateArtifact"), {
        token,
        body: JSON.stringify({ ...ids, name: "dist", mimeType: "application/zip", version: 7 }),
      });
      expect(created.status).toBe(200);
      const url = blobPath(JSON.parse(created.text).signed_upload_url);
      const bytes = "PK\u0003\u0004 through the proxy";
      const blockId = Buffer.from("000000").toString("base64");
      const block = await https(
        cred,
        "PUT",
        `${url}?comp=block&blockid=${encodeURIComponent(blockId)}`,
        {
          body: bytes,
        },
      );
      expect(block.status).toBe(201);
      const list = await https(cred, "PUT", `${url}?comp=blocklist`, {
        body: `<BlockList><Latest>${blockId}</Latest></BlockList>`,
      });
      expect(list.status).toBe(201);
      const fin = await https(cred, "POST", twirp("FinalizeArtifact"), {
        token,
        body: JSON.stringify({ ...ids, name: "dist", size: String(bytes.length) }),
      });
      expect(fin.status).toBe(200);
      artifact = (await listRunArtifacts(db, a.scope, a.runId)).map((r) => r.name);
      return done;
    })(await ctxOf());
    expect(artifact).toEqual(["dist"]);
    expect(upstreamSaw).toEqual([
      `POST ${twirp("CreateArtifact")}`,
      expect.stringMatching(/^PUT \/_artifacts\/.+\/upload\//),
      expect.stringMatching(/^PUT \/_artifacts\/.+\/upload\//),
      `POST ${twirp("FinalizeArtifact")}`,
    ]);
  });

  test("the proxy refuses every other destination, port, method and path; nothing reaches the control plane", async () => {
    await planned(true);
    const token = grant();
    await wrap(async (c) => {
      const cred = c.proxy!.credential;
      // Other hosts and ports: the CONNECT itself is refused.
      for (const [h, p] of [
        ["evil.example.test", 443],
        ["registry.npmjs.org", 443],
        ["169.254.169.254", 80],
        [HOST, 8443],
        [HOST, 80],
      ] as const) {
        const r = await connect(cred, h, p);
        expect(r.status).not.toBe(200);
        r.sock.destroy();
      }
      // The control plane's own host, but not an upload endpoint.
      const refused: [string, string][] = [
        ["POST", twirp("ListArtifacts")],
        ["POST", twirp("GetSignedArtifactURL")],
        ["POST", twirp("DeleteArtifact")],
        ["GET", "/_artifacts/x/download/dist"],
        ["PUT", "/_artifacts/x/download/dist"],
        ["GET", "/api/v1/orgs"],
        ["POST", "/"],
        ["PUT", "/_artifacts/x/upload/y/extra"],
        ["GET", `/_artifacts/${token}/upload/y`],
      ];
      for (const [m, p] of refused) {
        const r = await https(cred, m, p, { token, body: "{}" });
        expect([m, p, r.status >= 400]).toEqual([m, p, true]);
      }
      return done;
    })(await ctxOf());
    // Not one of those got as far as the service.
    expect(upstreamSaw).toEqual([]);
  });

  test("the upload-only token cannot list, ask for a download URL or download, even straight at the service", async () => {
    const token = grant();
    const call = async (m: string) =>
      (await svc.handle(
        new Request(`${BASE}${twirp(m)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "dist" }),
        }),
      ))!.status;
    expect(await call("ListArtifacts")).toBe(403);
    expect(await call("GetSignedArtifactURL")).toBe(403);
    expect(await call("DeleteArtifact")).toBe(403);
    expect(
      (await svc.handle(new Request(`${BASE}/_artifacts/${token}/download/dist`)))!.status,
    ).toBe(403);
  });

  test("with open egress the job reaches the service itself and has the full grant; local runs get none", () => {
    const provider = jobArtifactProvider(svc);
    const base = {
      runId: a.runId,
      attemptId: a.attemptId,
      scope: a.scope,
      klass: "release" as const,
      local: false,
    };
    const open = provider({ ...base, egress: "open" })!;
    expect(svc.grants.verify(open.token)?.mode).toBe("full");
    const none = provider({ ...base, egress: "none", proxyRoute: true })!;
    expect(svc.grants.verify(none.token)?.mode).toBe("upload");
    // No route: nothing to hand out.
    expect(provider({ ...base, egress: "none" })).toBeUndefined();
    expect(provider({ ...base, egress: "none", proxyRoute: true, local: true })).toBeUndefined();
  });
});
