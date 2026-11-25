import { z } from "zod";
import {
  appendAudit,
  getRunArtifactsByName,
  listRunArtifacts,
  resolveArtifactConsumption,
} from "../../db/repos";
import { listZipFiles, looksLikeZip, readZipFile, UnpackError } from "../../release/unpack";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";
import { principalId } from "../principal";

const source = z.object({
  run_id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
});

export const listArtifacts = defineOp({
  name: "get_artifacts",
  summary: "The artifacts a run recorded, with their provenance.",
  description:
    "Each artifact a run recorded: name, size, digest, how the digest was obtained (`reported` by " +
    "the recorder or `computed` by the control plane from the bytes), the trust class of the " +
    "producing run and the commit it ran at. The class and commit are set by the control plane " +
    "when the row is recorded, never by the caller, and a row is never changed. Artifact names " +
    "come from a workflow: untrusted text. Read-only.",
  input: z.object({ run_id: z.string().min(1).max(64) }),
  output: z.object({
    artifacts: z.array(
      z.object({
        name: z.string(),
        size: z.int(),
        sha256: z.string(),
        digest_source: z.enum(["reported", "computed"]),
        trust_class: z.string(),
        run_sha: z.string().nullable(),
        attempt_id: z.string(),
        created_at: z.string(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "project",
  http: { method: "GET", path: "/runs/{run_id}/artifacts" },
  async handler(ctx, input) {
    const rows = await listRunArtifacts(ctx.db, ctx.scope, input.run_id);
    return {
      artifacts: rows.map((a) => ({
        name: a.name,
        size: a.size,
        sha256: a.sha256,
        digest_source:
          a.digestSource === "computed" ? ("computed" as const) : ("reported" as const),
        trust_class: a.klass,
        run_sha: a.runSha,
        attempt_id: a.attemptId,
        created_at: new Date(a.createdAt).toISOString(),
      })),
    };
  },
});

export const checkArtifactConsumption = defineOp({
  name: "check_artifact_consumption",
  summary: "Whether a run may consume artifacts of other runs, and as what.",
  description:
    "For a consumer (a run, or a trust class by name) and a list of artifacts of this project, says per artifact whether it is " +
    "`allow` (same trust class or higher), `quarantine` (a lower class that the request named in " +
    "`quarantine`: delivered non-executable, never an input to a build) or `deny`. A release-class " +
    "consumer is denied anything below the release class, whatever it asks. Read-only: it " +
    "decides, it does not move bytes.",
  input: z.object({
    consumer_run_id: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("The run that would consume them; its class comes from its stored decision."),
    consumer_class: z
      .enum(["untrusted_pr", "trusted_pr", "protected", "release"])
      .optional()
      .describe("Instead of a run: ask whether a build of this class may take them."),
    sources: z.array(source).min(1).max(100),
    quarantine: z
      .array(source)
      .max(100)
      .optional()
      .describe("Sources the consumer explicitly asks to receive from a lower class."),
  }),
  output: z.object({
    results: z.array(
      z.object({
        run_id: z.string(),
        name: z.string(),
        decision: z.enum(["allow", "quarantine", "deny"]),
        reason: z.string().nullable(),
        trust_class: z.string().nullable(),
        sha256: z.string().nullable(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "project",
  http: { method: "POST", path: "/artifacts/check-consumption" },
  async handler(ctx, input) {
    if (input.sources.length === 0) throw new OpError("invalid_input", "no sources");
    if ((input.consumer_run_id === undefined) === (input.consumer_class === undefined))
      throw new OpError("invalid_input", "give exactly one of consumer_run_id or consumer_class");
    const res = await resolveArtifactConsumption(
      ctx.db,
      ctx.scope,
      input.consumer_run_id ?? { klass: input.consumer_class! },
      input.sources.map((s) => ({ runId: s.run_id, name: s.name })),
      (input.quarantine ?? []).map((s) => ({ runId: s.run_id, name: s.name })),
    );
    return {
      results: res.map((r) => ({
        run_id: r.source.runId,
        name: r.source.name,
        decision: r.decision.decision,
        reason: r.decision.decision === "deny" ? r.decision.reason : null,
        trust_class: r.artifact?.klass ?? null,
        sha256: r.artifact?.sha256 ?? null,
      })),
    };
  },
});

// ---- the stored bytes of an artifact (#544): what a client reads to sign a release ----

/** The largest zip read into memory to serve one file of it, and the largest file served that way. */
const MAX_ZIP_READ = 1024 ** 3;
const MAX_FILE_READ = 512 * 1024 ** 2;

const artifactName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/, "a plain artifact name")
  .describe("The artifact's name as the workflow uploaded it (one upload-artifact name).");

/** The same alphabet the lane reads file names by (release/unpack.ts). */
const filePath = z
  .string()
  .min(1)
  .max(190)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/+-]{0,189}$/, "a plain relative path")
  .refine((p) => !p.split("/").some((seg) => seg === "" || seg === "." || seg === ".."), {
    message: "no empty, . or .. segment",
  })
  .describe("The file's path inside the artifact, as `get_artifact_files` shows it.");

/**
 * The stored artifact for a run of the caller's own project, read from the artifact store with the
 * digest checked against the recorded one before a byte is used. The run and the name are looked
 * up inside the caller's scope, so another org's run is simply not found.
 */
async function storedArtifact(
  ctx: OpContext,
  runId: string,
  name: string,
): Promise<{ file: Blob; size: number }> {
  const blobs = ctx.artifactBlobs;
  if (!blobs) {
    throw new OpError("unavailable", "artifacts are not enabled on this instance", {
      reason: "artifacts_off",
    });
  }
  const [row] = await getRunArtifactsByName(ctx.db, ctx.scope, runId, [name]);
  if (!row) throw new OpError("not_found", "no such artifact in this run");
  const stored = await blobs.open(runId, name);
  if (!stored) throw new OpError("not_found", "the artifact's bytes are no longer stored");
  if (stored.sha256 !== row.sha256 || stored.size !== row.size) {
    throw new OpError("conflict", "the stored bytes differ from what the build recorded", {
      reason: "artifact_bytes_differ",
    });
  }
  return { file: stored.file, size: stored.size };
}

/** An artifact read is audited too: who read which bytes (never the bytes). */
function auditRead(ctx: OpContext, op: string, input: Record<string, unknown>): Promise<void> {
  return appendAudit(ctx.db, ctx.scope, {
    principalKind: ctx.principal.kind,
    principalId: principalId(ctx.principal),
    op,
    effect: "read",
    outcome: "ok",
    input,
  });
}

const zipFailure = (e: unknown): never => {
  if (e instanceof UnpackError)
    throw new OpError("conflict", `the artifact is not a readable zip: ${e.message}`, {
      reason: "unreadable_archive",
    });
  throw e;
};

export const getArtifactFiles = defineOp({
  name: "get_artifact_files",
  summary: "The files inside one stored artifact of a run, by path and size.",
  description:
    "Lists the files of a run's artifact: a zip (what `upload-artifact` stores by default) is read " +
    "with the same safe reader the release lane uses, and each file is its path in the zip and its " +
    "size; an artifact stored as one raw file is its own single file. Paths are what the release " +
    "lane signs and what `get_artifact_file` takes. Names are untrusted text from a workflow. The " +
    "run must be in the caller's project. Read-only; audited. Lists names and sizes only: the " +
    "bytes are `get_artifact_file` and `get_artifact`, which are REST downloads, not MCP tools.",
  input: z.object({ run_id: z.string().min(1).max(64), name: artifactName }),
  output: z.object({
    name: z.string(),
    size: z.int().describe("The stored artifact's size in bytes."),
    sha256: z.string().describe("The digest the build recorded for the stored artifact."),
    archive: z.boolean().describe("True when the artifact is a zip; false for one raw file."),
    files: z.array(z.object({ path: z.string(), size: z.int() })),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "project",
  http: { method: "GET", path: "/runs/{run_id}/artifacts/{name}/files" },
  async handler(ctx, i) {
    const { file, size } = await storedArtifact(ctx, i.run_id, i.name);
    if (size > MAX_ZIP_READ)
      throw new OpError("payload_too_large", "the artifact is too large to list");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const [row] = await getRunArtifactsByName(ctx.db, ctx.scope, i.run_id, [i.name]);
    let files: { path: string; size: number }[];
    let archive = false;
    if (looksLikeZip(bytes)) {
      archive = true;
      try {
        files = listZipFiles(bytes).map((f) => ({ path: f.name, size: f.size }));
      } catch (e) {
        return zipFailure(e);
      }
    } else {
      files = [{ path: i.name, size }];
    }
    await auditRead(ctx, "get_artifact_files", { run_id: i.run_id, name: i.name });
    return { name: i.name, size, sha256: row!.sha256, archive, files };
  },
});

export const getArtifactFile = defineOp({
  name: "get_artifact_file",
  summary: "Download ONE file out of a stored artifact zip of a run.",
  description:
    "Streams the bytes of one file inside a run's artifact: `GET " +
    "/runs/{run_id}/artifacts/{name}/files/{path}`, where `path` is the file's path as " +
    "`get_artifact_files` shows it (slashes allowed). The zip is read with the release lane's " +
    "safe reader (a `..` segment, a link, a bad CRC or a bomb is refused), the stored artifact's " +
    "digest is checked against what the build recorded first, and the file is capped at 512 MiB. " +
    "The response is `application/octet-stream` with a `Content-Disposition` of the file's " +
    "basename: these are the exact bytes the release lane signs, so a client can hash them and " +
    "compare with the approved digest. An artifact stored as one raw file is its own file (use its " +
    "name as the path). The run must be in the caller's project (another org's run is not_found). " +
    "Read-only; audited. REST only: MCP cannot stream bytes (use `get_artifact_files` there).",
  input: z.object({ run_id: z.string().min(1).max(64), name: artifactName, path: filePath }),
  output: z.custom<{ body: Blob | Uint8Array; filename: string; size: number }>(
    (v) => typeof v === "object" && v !== null && "body" in v,
  ),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "project",
  http: { method: "GET", path: "/runs/{run_id}/artifacts/{name}/files/{path}" },
  mcp: false,
  download: { contentType: "application/octet-stream" },
  async handler(ctx, i) {
    const { file, size } = await storedArtifact(ctx, i.run_id, i.name);
    if (size > MAX_ZIP_READ)
      throw new OpError("payload_too_large", "the artifact is too large to read");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let body: Uint8Array | undefined;
    if (looksLikeZip(bytes)) {
      try {
        body = readZipFile(bytes, i.path, { maxFileBytes: MAX_FILE_READ });
      } catch (e) {
        if (e instanceof UnpackError && e.code === "too_large")
          throw new OpError("payload_too_large", "the file is too large to download");
        return zipFailure(e);
      }
    } else if (i.path === i.name) {
      body = bytes;
    }
    if (!body) throw new OpError("not_found", "no such file in this artifact");
    await auditRead(ctx, "get_artifact_file", { run_id: i.run_id, name: i.name, path: i.path });
    return { body, filename: i.path.slice(i.path.lastIndexOf("/") + 1), size: body.length };
  },
});

export const getArtifact = defineOp({
  name: "get_artifact",
  summary: "Download one stored artifact of a run as it was uploaded (a zip, or one raw file).",
  description:
    "Streams the whole stored blob of a run's artifact: `GET /runs/{run_id}/artifacts/{name}`. " +
    "For an `upload-artifact` artifact that is the zip. Its digest was checked against what the " +
    "build recorded before the first byte is sent, so the bytes hash to `sha256` as " +
    "`get_artifacts` shows it. The response is `application/octet-stream` with a " +
    "`Content-Disposition` of the artifact's name. The run must be in the caller's project " +
    "(another org's run is not_found). Read-only; audited. REST only: MCP cannot stream bytes.",
  input: z.object({ run_id: z.string().min(1).max(64), name: artifactName }),
  output: z.custom<{ body: Blob | Uint8Array; filename: string; size: number }>(
    (v) => typeof v === "object" && v !== null && "body" in v,
  ),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "project",
  http: { method: "GET", path: "/runs/{run_id}/artifacts/{name}" },
  mcp: false,
  download: { contentType: "application/octet-stream" },
  async handler(ctx, i) {
    const { file, size } = await storedArtifact(ctx, i.run_id, i.name);
    await auditRead(ctx, "get_artifact", { run_id: i.run_id, name: i.name });
    return { body: file, filename: i.name, size };
  },
});
