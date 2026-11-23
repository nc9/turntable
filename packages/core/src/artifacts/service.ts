// The artifact service: what actions/upload-artifact and download-artifact (v4 and up) talk to,
// served from the control plane. The releases this repo pins (upload-artifact v7, download-artifact
// v8) use @actions/artifact 6.3.1, and v4 used 2.x; the protocol is the same twirp API
// (`ArtifactService`, at ACTIONS_RESULTS_URL) for the metadata and Azure block-blob requests for
// the bytes, to a "signed URL" the twirp API hands back. What 6.x adds, handled here:
// - CreateArtifact carries `version: 7` and a `mimeType` (a plain string in the JSON, as every
//   wrapper type is); `archive: false` uploads one raw file under its own name, not a zip;
// - ListArtifacts carries a `digest` ("sha256:<hex>") that download-artifact compares with the
//   digest of the bytes it received, failing the step on a mismatch by default;
// - a download is told what it is by Content-Type: a zip is extracted, anything else is written
//   as one file named by Content-Disposition. This service implements the twirp
// methods a single run needs and the three block-blob requests the client sends (Put Block, Put
// Block List, Put Blob), and nothing else. The bytes the client uploads are its zip of the files,
// stored and served as one blob.
//
// Credentials: the job's ACTIONS_RUNTIME_TOKEN is an artifact grant (grants.ts); the twirp calls
// carry it as a bearer token, and the blob URLs carry it in the path. Which run, attempt and org
// a request is for comes only from the grant: the ids the client puts in a request are ignored,
// so a job can only ever reach its own run's artifacts. A download is decided against the job's
// trust class (consume.ts): a release-class job gets nothing a lower class could have written.
import { createHash } from "node:crypto";
import type { Db } from "../db";
import {
  ArtifactConflict,
  ArtifactScopeError,
  getOrgQuotas,
  getRunArtifactsByName,
  listRunArtifacts,
  orgStoredBytes,
  recordArtifact,
  resolveArtifactConsumption,
  type ArtifactRow,
} from "../db";
import type { ArtifactGrant, ArtifactGrants } from "./grants";
import { looksLikeZip } from "../release/unpack";
import { ARTIFACT_NAME, ArtifactTooLargeError, type FsArtifactStore } from "./store";

export const TWIRP_PREFIX = "/twirp/github.actions.results.api.v1.ArtifactService/";
export const BLOB_PREFIX = "/_artifacts/";

export type ArtifactOptions = {
  db: Db;
  store: FsArtifactStore;
  grants: ArtifactGrants;
  /** Largest single artifact. */
  maxArtifactBytes: number;
  /** Public base URL the sandbox reaches the control plane at, no trailing slash. */
  baseUrl: string;
  /** How long a stored blob is kept (default 90 days). */
  retentionMs?: number;
  /** Told when a download was refused for a reason the job should see (no secrets in it). */
  onNotice?: (g: ArtifactGrant, message: string) => void;
  now?: () => number;
  /** Whether the grant's attempt is still running. Default: yes. */
  isActive?: (g: ArtifactGrant) => Promise<boolean>;
};

export const DEFAULT_RETENTION_MS = 90 * 86_400_000;
const MAX_UPLOADS_PER_ATTEMPT = 16;
const MAX_BLOCKS = 50_000;
const STAGING_TTL_MS = 3600_000;

type Upload = {
  id: string;
  grant: ArtifactGrant;
  name: string;
  /** Bytes staged so far (blocks and blob), counted against the org's quota room. */
  bytes: number;
  blocks: Map<string, number>;
  committed: { size: number; sha256: string } | undefined;
  createdAt: number;
};

class RpcError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, msg: string) {
    super(msg);
    this.status = status;
    this.code = code;
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const rpcError = (e: RpcError): Response => json(e.status, { code: e.code, msg: e.message });

/** A stable number for an artifact row: the client wants an integer id, the rows have ulids. */
export const numericId = (id: string): number =>
  parseInt(createHash("sha256").update(id).digest("hex").slice(0, 12), 16);

export type ArtifactService = {
  /** Handles the twirp API and `/_artifacts/...`; undefined for any other path. */
  handle(req: Request): Promise<Response | undefined>;
  /** What a job's ACTIONS_RESULTS_URL is set to. */
  resultsUrl: string;
  grants: ArtifactGrants;
  /** Drops abandoned uploads and blobs past retention. */
  sweep(): Promise<void>;
};

export function createArtifactService(o: ArtifactOptions): ArtifactService {
  const now = o.now ?? Date.now;
  const base = o.baseUrl.replace(/\/+$/, "");
  const retention = o.retentionMs ?? DEFAULT_RETENTION_MS;
  const uploads = new Map<string, Upload>();
  /** Staged bytes of uploads not yet recorded, per org: they count against the quota too. */
  const pendingByOrg = new Map<string, number>();
  const addPending = (orgId: string, n: number) =>
    pendingByOrg.set(orgId, Math.max(0, (pendingByOrg.get(orgId) ?? 0) + n));

  const drop = async (u: Upload) => {
    uploads.delete(u.id);
    addPending(u.grant.scope.orgId, -u.bytes);
    await o.store.discard(u.id).catch(() => {});
  };
  const uploadsOf = (attemptId: string) =>
    [...uploads.values()].filter((u) => u.grant.attemptId === attemptId);

  async function grantOf(token: string): Promise<ArtifactGrant | undefined> {
    const g = o.grants.verify(token);
    if (!g) return undefined;
    if (o.isActive && !(await o.isActive(g))) {
      o.grants.revoke(g.attemptId);
      for (const u of uploadsOf(g.attemptId)) await drop(u);
      return undefined;
    }
    return g;
  }

  /** Bytes the org may still stage: the quota, less what is stored and what is in flight. */
  async function room(orgId: string): Promise<number> {
    const limit = (await getOrgQuotas(o.db, orgId)).maxStoredBytes;
    if (limit === null) return Number.MAX_SAFE_INTEGER;
    return limit - (await orgStoredBytes(o.db, orgId)) - (pendingByOrg.get(orgId) ?? 0);
  }

  /** Whether the job may take this artifact, with the reason it may not. */
  async function readable(
    g: ArtifactGrant,
    rows: ArtifactRow[],
  ): Promise<{ ok: ArtifactRow[]; refused: string[] }> {
    const ok: ArtifactRow[] = [];
    const refused: string[] = [];
    const decided = await resolveArtifactConsumption(
      o.db,
      g.scope,
      { klass: g.klass },
      rows.map((r) => ({ runId: g.runId, name: r.name })),
    );
    for (const [i, d] of decided.entries()) {
      const row = rows[i]!;
      const dec = d.decision;
      if (dec.decision === "allow") {
        if (now() - row.createdAt < retention) ok.push(row);
      } else {
        // Quarantine is never offered here: the artifact actions cannot ask for it.
        const why = dec.decision === "deny" ? dec.reason : "it came from a lower trust class";
        refused.push(`artifact ${row.name} refused: ${why}`);
      }
    }
    return { ok, refused };
  }

  // ---- twirp ----

  const asObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  /** A protobuf wrapper (StringValue, Int64Value) is a bare string in JSON; `{value}` is tolerated. */
  const wrapped = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    const x = asObj(v).value;
    return typeof x === "string" ? x : undefined;
  };

  async function createArtifact(g: ArtifactGrant, token: string, body: Record<string, unknown>) {
    const name = typeof body.name === "string" ? body.name : "";
    if (!ARTIFACT_NAME.test(name))
      throw new RpcError(
        400,
        "invalid_argument",
        "artifact name must be 1 to 200 characters of letters, digits and . _ + -",
      );
    const [existing] = await getRunArtifactsByName(o.db, g.scope, g.runId, [name]);
    if (existing || [...uploads.values()].some((u) => u.grant.runId === g.runId && u.name === name))
      throw new RpcError(
        409,
        "already_exists",
        `an artifact named ${name} already exists in this run`,
      );
    if (uploadsOf(g.attemptId).length >= MAX_UPLOADS_PER_ATTEMPT)
      throw new RpcError(429, "resource_exhausted", "too many uploads in progress for this job");
    if ((await room(g.scope.orgId)) <= 0)
      throw new RpcError(413, "resource_exhausted", "the org's stored-bytes quota is full");
    const id = crypto.randomUUID().replaceAll("-", "");
    uploads.set(id, {
      id,
      grant: g,
      name,
      bytes: 0,
      blocks: new Map(),
      committed: undefined,
      createdAt: now(),
    });
    return { ok: true, signed_upload_url: `${base}${BLOB_PREFIX}${token}/upload/${id}` };
  }

  async function finalizeArtifact(g: ArtifactGrant, body: Record<string, unknown>) {
    const name = typeof body.name === "string" ? body.name : "";
    const u = uploadsOf(g.attemptId).find((x) => x.name === name && x.grant.runId === g.runId);
    if (!u || !u.committed)
      throw new RpcError(412, "failed_precondition", `no completed upload for ${name}`);
    // The digest and size are read back from the staged file, never taken from the client. The
    // client's own figures are only compared: a mismatch means the bytes are not what it sent.
    const staged = await o.store.staged(u.id);
    if (!staged || staged.sha256 !== u.committed.sha256 || staged.size !== u.committed.size) {
      await drop(u);
      throw new RpcError(
        400,
        "invalid_argument",
        "the staged upload changed after it was received",
      );
    }
    const claimed = wrapped(body.hash);
    if (claimed !== undefined && claimed !== `sha256:${staged.sha256}`) {
      await drop(u);
      throw new RpcError(
        400,
        "invalid_argument",
        "the uploaded bytes do not match the reported hash",
      );
    }
    const size = body.size;
    if (size !== undefined && String(size) !== String(staged.size)) {
      await drop(u);
      throw new RpcError(
        400,
        "invalid_argument",
        "the uploaded size does not match the reported size",
      );
    }
    let row: ArtifactRow;
    try {
      row = await recordArtifact(o.db, g.scope, {
        runId: g.runId,
        attemptId: g.attemptId,
        name,
        sha256: staged.sha256,
        size: staged.size,
        computedByControlPlane: true,
      });
    } catch (err) {
      await drop(u);
      if (err instanceof ArtifactConflict)
        throw new RpcError(409, "already_exists", `an artifact named ${name} already exists`);
      if (err instanceof ArtifactScopeError)
        throw new RpcError(403, "permission_denied", "no such run");
      throw err;
    }
    await o.store.promote(u.id, g.runId, name);
    uploads.delete(u.id);
    addPending(g.scope.orgId, -u.bytes);
    return { ok: true, artifact_id: String(numericId(row.id)) };
  }

  async function listArtifacts(g: ArtifactGrant, body: Record<string, unknown>) {
    // The run is the grant's. Any run id in the request is ignored.
    const nameFilter = wrapped(body.name_filter ?? body.nameFilter);
    const idFilter = wrapped(body.id_filter ?? body.idFilter);
    const rows = (await listRunArtifacts(o.db, g.scope, g.runId)).filter(
      (r) =>
        (nameFilter === undefined || r.name === nameFilter) &&
        (idFilter === undefined || String(numericId(r.id)) === idFilter),
    );
    const { ok, refused } = await readable(g, rows);
    for (const m of refused) o.onNotice?.(g, m);
    return {
      artifacts: ok.map((r) => ({
        workflow_run_backend_id: g.runId,
        workflow_job_run_backend_id: r.attemptId,
        database_id: String(numericId(r.id)),
        name: r.name,
        size: String(r.size),
        created_at: new Date(r.createdAt).toISOString(),
        digest: `sha256:${r.sha256}`,
      })),
    };
  }

  async function signedUrl(g: ArtifactGrant, token: string, body: Record<string, unknown>) {
    const name = typeof body.name === "string" ? body.name : "";
    const rows = await getRunArtifactsByName(o.db, g.scope, g.runId, [name]);
    const { ok, refused } = await readable(g, rows);
    for (const m of refused) o.onNotice?.(g, m);
    if (ok.length === 0)
      throw new RpcError(404, "not_found", `no artifact named ${name} in this run`);
    return { signed_url: `${base}${BLOB_PREFIX}${token}/download/${encodeURIComponent(name)}` };
  }

  async function twirp(req: Request, method: string): Promise<Response> {
    const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
    const token = m?.[1] ?? "";
    // The same answer for a bad token and an ended job.
    const g = await grantOf(token);
    if (!g) return rpcError(new RpcError(401, "unauthenticated", "unauthorized"));
    if (req.method !== "POST")
      return rpcError(new RpcError(405, "bad_route", "twirp calls are POST"));
    let body: Record<string, unknown>;
    try {
      body = asObj(await req.json());
    } catch {
      return rpcError(new RpcError(400, "malformed", "bad request body"));
    }
    try {
      // An upload-only grant can create and finalize its own uploads, nothing else.
      if (g.mode === "upload" && method !== "CreateArtifact" && method !== "FinalizeArtifact")
        throw new RpcError(403, "permission_denied", "this credential can only upload");
      switch (method) {
        case "CreateArtifact":
          return json(200, await createArtifact(g, token, body));
        case "FinalizeArtifact":
          return json(200, await finalizeArtifact(g, body));
        case "ListArtifacts":
          return json(200, await listArtifacts(g, body));
        case "GetSignedArtifactURL":
          return json(200, await signedUrl(g, token, body));
        case "DeleteArtifact":
          // An artifact is recorded once and never replaced or removed by a job.
          throw new RpcError(501, "unimplemented", "artifacts cannot be deleted or overwritten");
        default:
          throw new RpcError(404, "bad_route", "no such method");
      }
    } catch (err) {
      if (err instanceof RpcError) return rpcError(err);
      console.error("turntable: artifact service error", err);
      return rpcError(new RpcError(500, "internal", "internal error"));
    }
  }

  // ---- blob requests (what the Azure client sends to the signed URLs) ----

  async function blobUpload(g: ArtifactGrant, req: Request, url: URL, uploadId: string) {
    const u = uploads.get(uploadId);
    // An upload belongs to the attempt that created it.
    if (!u || u.grant.attemptId !== g.attemptId) return new Response(null, { status: 404 });
    if (req.method !== "PUT") return new Response(null, { status: 405 });
    if (u.committed) return new Response(null, { status: 409 });
    const comp = url.searchParams.get("comp");
    // The most this upload may still add: the per-artifact cap and what the org has left.
    const allowed = async (): Promise<number> =>
      Math.min(o.maxArtifactBytes - u.bytes, await room(u.grant.scope.orgId));
    const declared = Number(req.headers.get("content-length") ?? 0);
    try {
      if (comp === "block") {
        const blockId = url.searchParams.get("blockid") ?? "";
        if (blockId === "" || blockId.length > 128 || u.blocks.size >= MAX_BLOCKS)
          return new Response(null, { status: 400 });
        if (declared > (await allowed())) return new Response("too large", { status: 413 });
        // A block sent again replaces the first (Azure does the same): its old bytes are released.
        const before = u.blocks.get(blockId) ?? 0;
        u.bytes -= before;
        addPending(u.grant.scope.orgId, -before);
        const limit = await allowed();
        const n = await o.store.stageBlock(u.id, blockId, req.body, limit);
        u.blocks.set(blockId, n);
        u.bytes += n;
        addPending(u.grant.scope.orgId, n);
        return new Response(null, { status: 201 });
      }
      if (comp === "blocklist") {
        const xml = await req.text();
        const ids = [...xml.matchAll(/<(?:Latest|Committed|Uncommitted)>([^<]+)</g)].map(
          (x) => x[1]!,
        );
        if (ids.length === 0 || ids.some((id) => !u.blocks.has(id)))
          return new Response("unknown block", { status: 400 });
        u.committed = await o.store.assemble(u.id, ids, o.maxArtifactBytes);
        return new Response(null, { status: 201, headers: { etag: `"${u.committed.sha256}"` } });
      }
      if (comp === null) {
        if (declared > (await allowed())) return new Response("too large", { status: 413 });
        const staged = await o.store.stageBlob(u.id, req.body, await allowed());
        u.bytes = staged.size;
        addPending(u.grant.scope.orgId, staged.size);
        u.committed = staged;
        return new Response(null, { status: 201, headers: { etag: `"${staged.sha256}"` } });
      }
      return new Response(null, { status: 400 });
    } catch (err) {
      if (err instanceof ArtifactTooLargeError) {
        await drop(u);
        return new Response("too large", { status: 413 });
      }
      throw err;
    }
  }

  async function blobDownload(g: ArtifactGrant, req: Request, name: string) {
    if (req.method !== "GET") return new Response(null, { status: 405 });
    if (g.mode === "upload")
      return new Response("this credential can only upload", { status: 403 });
    const rows = await getRunArtifactsByName(o.db, g.scope, g.runId, [name]);
    const { ok, refused } = await readable(g, rows);
    for (const m of refused) o.onNotice?.(g, m);
    const row = ok[0];
    if (!row) return new Response("not found", { status: 404 });
    const blob = await o.store.open(g.runId, row.name);
    if (!blob) return new Response("not found", { status: 404 });
    // What is served is what was recorded: the digest is recomputed from the file now.
    if (blob.sha256 !== row.sha256 || blob.size !== row.size) {
      o.onNotice?.(
        g,
        `artifact ${row.name} refused: the stored bytes do not match the recorded digest`,
      );
      return new Response("integrity check failed", { status: 500 });
    }
    // The client extracts what is a zip and saves anything else as one file under this name. Which
    // it is comes from the bytes (the client's own `mimeType` is never echoed back).
    const head = new Uint8Array(await blob.file.slice(0, 4).arrayBuffer());
    const zip = looksLikeZip(head);
    return new Response(blob.file, {
      headers: {
        "content-type": zip ? "application/zip" : "application/octet-stream",
        "content-length": String(blob.size),
        ...(zip ? {} : { "content-disposition": `attachment; filename="${row.name}"` }),
      },
    });
  }

  return {
    grants: o.grants,
    resultsUrl: `${base}/`,
    async sweep() {
      for (const u of [...uploads.values()])
        if (now() - u.createdAt > STAGING_TTL_MS) await drop(u);
      await o.store.sweep(now() - retention, now() - STAGING_TTL_MS);
    },
    async handle(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname.startsWith(TWIRP_PREFIX))
          return await twirp(req, url.pathname.slice(TWIRP_PREFIX.length));
        if (!url.pathname.startsWith(BLOB_PREFIX)) return undefined;
        const m = /^([^/]+)\/(upload|download)\/([^/]+)$/.exec(
          url.pathname.slice(BLOB_PREFIX.length),
        );
        if (!m) return new Response("not found", { status: 404 });
        const g = await grantOf(m[1]!);
        if (!g) return new Response("unauthorized", { status: 401 });
        const arg = decodeURIComponent(m[3]!);
        return m[2] === "upload"
          ? await blobUpload(g, req, url, arg)
          : await blobDownload(g, req, arg);
      } catch (err) {
        console.error("turntable: artifact service error", err);
        return new Response("internal error", { status: 500 });
      }
    },
  };
}
