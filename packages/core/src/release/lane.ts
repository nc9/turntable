// The release lane: takes release requests, and signs only what it has checked itself.
//
// A request is only a request. The lane trusts nothing in the main process's rows for what to
// sign. It re-asks the forge which commit the tag points at, re-reads the artifact bytes and
// recomputes their digests, and compares them with what it attested the first time it saw them,
// in a file the main process cannot reach. Only then does it call the signing service, which
// applies its own policy on top (release class, release ref, approvals).
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db";
import {
  appendAudit,
  claimNextReleaseRequest,
  finishReleaseRequest,
  getFreeze,
  getRun,
  listReleaseRequests,
  type ReleaseRequest,
} from "../db/repos";
import { CONFIG_CHANGED_REASON, type AttestationStore } from "./attest";
import type { ArtifactBytes } from "./artifacts";
import { verifyCosignatures, type CosignInput, type VerifiedCosign } from "./cosign";
import { ReleaseFiles } from "./files";
import type { ForgeFacts } from "./forge";
import { planAssets, publishGithubRelease } from "./publish/github-release";
import { verifyOciImage } from "./publish/oci";
import { inspectNpmTarball, npmTarballOf, publishNpm } from "./publish/npm";
import type { PublishTarget, PublishWiring, TargetResult } from "./publish/types";

/** The part of the signing service the lane uses (SigningService.signRelease). */
export interface ReleaseSigner {
  /** A dry run's check that the project's signing key is there to sign with. Signs nothing. */
  checkKey?(scope: {
    orgId: string;
    projectId: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  signRelease(
    scope: { orgId: string; projectId: string },
    req: {
      runId: string;
      artifacts: readonly string[];
      /** What the lane verified itself: the service signs only if its own read is exactly this. */
      verified: {
        sha: string;
        repo: string;
        /** `refs/tags/<tag>`: the run must have been built from exactly this ref. */
        ref: string;
        subjects: readonly { name: string; sha256: string }[];
        /** The zips the subjects were unpacked from, with the digest of each zip. */
        archives?: readonly { name: string; sha256: string }[];
        /** The lane's own configuration version, read before signing: an approval must name it. */
        configVersion?: number;
      };
    },
  ): Promise<
    | { ok: true; envelope: unknown; keyid: string; subjects: { name: string; sha256: string }[] }
    | { ok: false; reason: string; detail?: string }
  >;
}

/** The digests the main database recorded for a run's artifacts. Read here only to compare. */
export interface ArtifactRecords {
  recorded(
    scope: { orgId: string; projectId: string },
    runId: string,
    names: readonly string[],
  ): Promise<{ name: string; sha256: string; size?: number }[]>;
}

export type LaneDenial =
  | "bad_tag"
  | "unknown_run"
  | "no_repo"
  | "frozen"
  | "repo_not_pinned"
  | "repo_mismatch"
  | "signed_subjects_differ"
  | "ref_mismatch"
  | "tag_not_found"
  | "sha_mismatch"
  | "no_artifacts"
  | "artifact_not_recorded"
  | "artifact_bytes_missing"
  | "digest_mismatch"
  | "size_mismatch"
  | "unpack_failed"
  | "duplicate_subject"
  | "attestation_mismatch"
  | "cosign_config_error"
  | "cosign_bad_request"
  | "cosign_missing"
  | "cosign_unexpected"
  | "cosign_duplicate"
  | "cosign_bad_encoding"
  | "cosign_artifact_missing"
  | "cosign_artifact_differs"
  | "cosign_manifest_check"
  | "run_not_successful"
  | "no_signing_key"
  | "npm_tarball_check"
  | "publish_plan_refused"
  | "signature_invalid"
  | "signature_not_minimal_der"
  | `signer:${string}`;

export interface LaneOptions {
  db: Db;
  forge: ForgeFacts;
  bytes: ArtifactBytes;
  records: ArtifactRecords;
  attest: AttestationStore;
  signer: ReleaseSigner;
  /** Publishes the signed release to the project's declared targets, when given. */
  publish?: PublishWiring;
  /** This lane's identity in claimed_by. */
  owner: string;
  /**
   * Where artifact zips are unpacked, each into a fresh directory that is removed afterwards.
   * Default: a directory under the system temp directory.
   */
  unpackRoot?: string;
  now?: () => number;
  log?: (m: string) => void;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const TAG = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;

type Decision =
  | {
      status: "signed";
      result: unknown;
      facts: Record<string, unknown>;
      /** What was verified and signed, for the publish step. */
      verified: {
        repo: string;
        sha: string;
        digests: Record<string, string>;
        envelope: unknown;
        /** The lane's configuration version the approval was judged under. */
        configVersion: number;
        /** The co-signatures the lane verified (#544), published next to the provenance. */
        cosignatures: VerifiedCosign[];
        /** The signed files, still unpacked; the lane removes them when it is done. */
        files: ReleaseFiles;
      };
    }
  | {
      /** A dry run: everything was verified; nothing was signed or published. */
      status: "planned";
      result: unknown;
      facts: Record<string, unknown>;
    }
  | { status: "refused"; reason: LaneDenial; detail?: string; facts: Record<string, unknown> };

const KIND_RANK: Record<string, number> = { "github-release": 0, npm: 1, "oci-image": 2 };

/**
 * The order targets are published in, explicit and never the key order: the GitHub release first
 * (draft, every asset, published once), then npm (only once that release is published), then an
 * image (whether its provenance could go on a release asset depends on the release targets). Within
 * one kind, by key.
 */
export function publishOrder(targets: Record<string, PublishTarget>): string[] {
  return Object.keys(targets).toSorted(
    (a, b) =>
      KIND_RANK[targets[a]!.kind]! - KIND_RANK[targets[b]!.kind]! || (a < b ? -1 : a > b ? 1 : 0),
  );
}

export class ReleaseLane {
  readonly #o: LaneOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;

  constructor(o: LaneOptions) {
    this.#o = o;
  }

  /** Handles one pending request. Returns false when there was none. */
  async processNext(): Promise<boolean> {
    const now = this.#o.now ?? Date.now;
    const req = await claimNextReleaseRequest(this.#o.db, this.#o.owner, now());
    if (!req) return false;
    const scope = { orgId: req.orgId, projectId: req.projectId };
    let decision: Decision;
    try {
      decision = await this.#decide(req, scope, req.dryRun === true);
    } catch (err) {
      // A forge or filesystem failure: nothing was signed, and the request says so.
      const msg = err instanceof Error ? err.message : String(err);
      await finishReleaseRequest(
        this.#o.db,
        req.id,
        this.#o.owner,
        { status: "error", reason: "lane_error", detail: msg.slice(0, 300) },
        now(),
      );
      await this.#audit(scope, req, "error:lane_error", { detail: msg.slice(0, 300) });
      return true;
    }
    if (decision.status === "planned") {
      // A dry run ends here: no approval was read or spent, nothing was signed or published.
      await finishReleaseRequest(
        this.#o.db,
        req.id,
        this.#o.owner,
        { status: "signed", result: decision.result, facts: decision.facts },
        now(),
      );
      await this.#audit(scope, req, "dry_run:ok", decision.facts);
      return true;
    }
    // Signed: now publish what was verified. A failure here never un-signs the release; each
    // target says how it went, and a re-run of the same request resumes where it stopped.
    let published: TargetResult[] = [];
    if (decision.status === "signed") {
      // Remembered in the lane's own file: what the release proxy may hand rules out for.
      this.#o.attest.saveVerifiedCosignatures(
        { ...scope, runId: req.runId },
        decision.verified.cosignatures,
        now(),
      );
      this.#o.attest.approveRelease(
        { ...scope, runId: req.runId },
        {
          repo: decision.verified.repo,
          tag: req.tag,
          sha: decision.verified.sha,
          artifacts: Object.keys(decision.verified.digests),
          envelope: JSON.stringify(decision.verified.envelope),
          configVersion: decision.verified.configVersion,
        },
        now(),
      );
      try {
        published = await this.#publish(
          req,
          scope,
          decision.verified,
          false,
          decision.verified.files,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        published = [
          { target: "*", state: "failed", reason: "publish_error", detail: msg.slice(0, 200) },
        ];
        await this.#audit(scope, req, "error:publish_error", { detail: msg.slice(0, 200) });
      }
    }
    if (decision.status === "signed") await decision.verified.files.dispose();
    await finishReleaseRequest(
      this.#o.db,
      req.id,
      this.#o.owner,
      decision.status === "signed"
        ? {
            status: "signed",
            result: {
              ...(decision.result as Record<string, unknown>),
              ...(published.length > 0 ? { published } : {}),
            },
            facts: decision.facts,
          }
        : {
            status: "refused",
            reason: decision.reason,
            detail: decision.detail,
            facts: decision.facts,
          },
      now(),
    );
    await this.#audit(
      scope,
      req,
      decision.status === "signed" ? "ok" : `refused:${decision.reason}`,
      decision.facts,
    );
    return true;
  }

  async #decide(
    req: ReleaseRequest,
    scope: { orgId: string; projectId: string },
    dry: boolean,
  ): Promise<Decision> {
    const facts: Record<string, unknown> = { tag: req.tag, run: req.runId };
    const refuse = (reason: LaneDenial, detail?: string): Decision => ({
      status: "refused",
      reason,
      ...(detail ? { detail } : {}),
      facts,
    });
    // An incident freeze stops releases, checked here as well as at claim time, and again just
    // before signing.
    if ((await getFreeze(this.#o.db, scope)).frozen) return refuse("frozen");
    if (!TAG.test(req.tag) || req.tag.includes("..")) return refuse("bad_tag");
    const run = await getRun(this.#o.db, scope, req.runId);
    if (!run) return refuse("unknown_run");
    if (!run.repo) return refuse("no_repo");
    // The repository comes from the lane's own pinned mapping, never from a row the main process
    // can write: a run row naming another repo cannot redirect the forge check.
    const pinned = this.#o.attest.pinnedRepo(scope.orgId, scope.projectId);
    if (!pinned)
      return refuse(
        "repo_not_pinned",
        "pin the project's repository with `turntable release pin-repo`",
      );
    if (run.repo.toLowerCase() !== pinned)
      return refuse("repo_mismatch", `the project is pinned to ${pinned}`);
    if (run.ref !== `refs/tags/${req.tag}`) return refuse("ref_mismatch", `run ref is ${run.ref}`);
    if (dry && run.status !== "success")
      return refuse("run_not_successful", `the run is ${run.status}`);

    // The forge, asked here, with this lane's own credential: the tag must exist and must point
    // at exactly the commit the run says it built.
    const tag = await this.#o.forge.tagCommit(pinned, req.tag);
    facts.forgeSha = tag.found ? tag.sha : null;
    facts.runSha = run.sha;
    if (!tag.found) return refuse("tag_not_found");
    if (!run.sha || tag.sha.toLowerCase() !== run.sha.toLowerCase()) {
      return refuse("sha_mismatch", `the forge says ${req.tag} is ${tag.sha}`);
    }

    const names = JSON.parse(req.artifacts) as string[];
    if (names.length === 0) return refuse("no_artifacts");
    const recorded = await this.#o.records.recorded(scope, req.runId, names);
    const byName = new Map(recorded.map((r) => [r.name, r.sha256]));
    const sizeOf = new Map(recorded.map((r) => [r.name, r.size]));
    const missing = names.filter((n) => !byName.has(n));
    if (missing.length > 0) return refuse("artifact_not_recorded", missing.join(", "));

    // The artifacts are transport. Each is checked against what the build recorded (its own
    // digest and size) and only then unpacked, safely, and what gets signed is the files in it.
    const opened = await ReleaseFiles.open({
      bytes: this.#o.bytes,
      runId: req.runId,
      names,
      unpackRoot: this.#o.unpackRoot ?? join(tmpdir(), "turntable-release-unpack"),
      check: (name, bytes) => {
        const actual = sha256(bytes);
        facts.digests = { ...(facts.digests as object), [name]: actual };
        // The bytes must be what the build recorded...
        if (actual !== byName.get(name)) return "digest_mismatch";
        // ...and be as long as the build said: the recorded size is what the org's stored-bytes
        // quota charged, and the stored file is where the true size is. Same digest, other length
        // can only mean the recorded size is wrong.
        const recordedSize = sizeOf.get(name);
        if (recordedSize !== undefined && recordedSize !== bytes.length)
          return `size_mismatch:${name}: recorded ${recordedSize}, stored ${bytes.length}`;
        return undefined;
      },
    });
    if (!opened.ok) {
      if (opened.reason !== "rejected") return refuse(opened.reason, opened.detail);
      return opened.cause.startsWith("size_mismatch:")
        ? refuse("size_mismatch", opened.cause.slice("size_mismatch:".length))
        : refuse("digest_mismatch", opened.detail);
    }
    const files = opened.files;
    const digests = files.digests;
    facts.digests = digests;
    if (files.archives.length > 0) facts.archives = files.archives;
    // The unpacked files stay for the publish step when this signs, and go on any other outcome.
    let keep = false;
    try {
      // Co-signatures (#544): checked here, by the lane, under the public keys in its own file,
      // over the exact bytes it re-hashed, before anything is attested, signed or published.
      let cosigs: VerifiedCosign[] = [];
      let cosigOutputs: string[] = [];
      {
        let keys;
        let carried: CosignInput[] = [];
        try {
          keys = this.#o.attest.cosignKeys(scope.orgId, scope.projectId);
        } catch (e) {
          return refuse(
            "cosign_config_error",
            (e instanceof Error ? e.message : String(e)).slice(0, 200),
          );
        }
        try {
          carried = req.cosignatures ? (JSON.parse(req.cosignatures) as CosignInput[]) : [];
          if (!Array.isArray(carried)) throw new Error("not a list");
        } catch {
          return refuse("cosign_bad_request", "the carried co-signatures are not readable");
        }
        if (keys.length > 0 || carried.length > 0) {
          const out = await verifyCosignatures(
            keys,
            carried,
            {
              read: (n) => files.readBytes(n),
              artifactOf: (n) => files.artifactOf(n),
              filesOf: (a) => files.filesOf(a),
            },
            digests,
            req.tag,
            { signaturesOptional: dry },
          );
          facts.cosignatures = out.reports;
          if (!out.ok) return refuse(out.reason as LaneDenial, out.detail);
          cosigs = out.verified;
          cosigOutputs = out.outputs;
        }
      }
      // ...and what this lane attested for this TAG before, in a store the main process cannot
      // write. Keyed by the release identity, not the run: a new run for an attested tag gets no
      // fresh first sight, and a tag is never signed twice with different digests.
      const identity = {
        orgId: scope.orgId,
        projectId: scope.projectId,
        repo: pinned,
        tag: req.tag,
      };
      const c = this.#o.attest.checkRelease(identity, digests);
      if (c.state === "mismatch") return refuse("attestation_mismatch", c.why);
      if (dry) {
        // Everything above is what a real request checks. From here a real one signs; this one
        // checks the signing key is there and plans the publish, and stops.
        if (!this.#o.signer.checkKey)
          return refuse("no_signing_key", "this lane's signer cannot check its key");
        const key = await this.#o.signer.checkKey(scope);
        if (!key.ok) return refuse("no_signing_key", key.reason);
        const planned = await this.#plan(req, scope, files, cosigOutputs);
        if (!planned.ok) return refuse(planned.reason as LaneDenial, planned.detail);
        return {
          status: "planned",
          result: {
            dry_run: true,
            plan: planned.plan,
            ...(cosigs.length > 0
              ? {
                  cosignatures: cosigs.map((x) => ({
                    name: x.name,
                    key_id: x.keyId,
                    output_name: x.outputName,
                  })),
                }
              : {}),
          },
          facts: { ...facts, dry_run: true },
        };
      }
      const now = (this.#o.now ?? Date.now)();
      // The configuration the approval is judged against, and (below) the one the signed release
      // is recorded under: a change in between leaves it stale, so a publish refuses.
      const configVersion = this.#o.attest.configVersion();
      this.#o.attest.attestRelease(identity, digests, now);

      if ((await getFreeze(this.#o.db, scope)).frozen) return refuse("frozen");

      // The service signs exactly what was verified here: the commit the forge confirmed, the
      // pinned repository and the digests computed from the bytes. If a row changed since, it
      // refuses; and what comes back must be exactly these subjects.
      const subjects = Object.keys(digests).map((name) => ({ name, sha256: digests[name]! }));
      const out = await this.#o.signer.signRelease(scope, {
        runId: req.runId,
        artifacts: names,
        verified: {
          sha: tag.sha,
          repo: pinned,
          ref: `refs/tags/${req.tag}`,
          subjects,
          ...(files.archives.length > 0 ? { archives: files.archives } : {}),
          configVersion,
        },
      });
      if (!out.ok) return refuse(`signer:${out.reason}`, out.detail);
      const got = [...out.subjects].toSorted((x, y) => x.name.localeCompare(y.name));
      const want = [...subjects].toSorted((x, y) => x.name.localeCompare(y.name));
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        return refuse(
          "signed_subjects_differ",
          "the signed statement does not name what was verified",
        );
      }
      keep = true;
      return {
        status: "signed",
        result: {
          keyid: out.keyid,
          envelope: out.envelope,
          subjects: out.subjects,
          ...(cosigs.length > 0
            ? {
                cosignatures: cosigs.map((c) => ({
                  key: c.key,
                  file: c.signs,
                  key_id: c.keyId,
                  output_name: c.outputName,
                  signature_sha256: c.signatureSha256,
                })),
              }
            : {}),
        },
        facts,
        verified: {
          repo: pinned,
          sha: tag.sha,
          digests,
          envelope: out.envelope,
          cosignatures: cosigs,
          files,
          configVersion,
        },
      };
    } finally {
      if (!keep) await files.dispose();
    }
  }

  /**
   * What a dry run reports: for each configured target what it would publish, in publish order,
   * checked the way a publish checks it (names, tarball, version). Reads only; sends nothing.
   */
  async #plan(
    req: ReleaseRequest,
    scope: { orgId: string; projectId: string },
    files: ReleaseFiles,
    cosigOutputs: readonly string[],
  ): Promise<
    | { ok: true; plan: { targets: unknown[]; note?: string } }
    | { ok: false; reason: string; detail: string }
  > {
    const targets = this.#o.attest.publishTargets(scope.orgId, scope.projectId);
    const keys = publishOrder(targets);
    if (keys.length === 0) return { ok: true, plan: { targets: [], note: "none configured" } };
    const ctx = {
      filesOf: (a: string) => files.filesOf(a),
      digests: files.digests,
      cosignatures: cosigOutputs.map((outputName) => ({ outputName, signature: new Uint8Array() })),
    };
    const out: unknown[] = [];
    for (const key of keys) {
      const t = targets[key]!;
      const no = (reason: string, detail: string) => ({
        ok: false as const,
        reason: "publish_plan_refused",
        detail: `${key}: ${reason}: ${detail}`,
      });
      if (t.kind === "github-release") {
        const missing = t.assets.filter((n) => !(n in files.digests));
        if (missing.length > 0) return no("artifact_not_requested", missing.join(", "));
        const p = planAssets(t, ctx, true);
        if (!p.ok) return no(p.reason, p.detail);
        out.push({
          key,
          kind: t.kind,
          order: out.length + 1,
          assets: p.assets.map((a) => a.asset),
        });
      } else if (t.kind === "npm") {
        const found = npmTarballOf(ctx, t.artifact);
        if (!found.ok) return no(found.reason, found.detail);
        const bytes = await files.readBytes(found.file);
        const insp = bytes ? inspectNpmTarball(bytes, t.package, req.tag) : undefined;
        if (!insp?.ok)
          return no(insp?.reason ?? "artifact_bytes_missing", insp?.detail ?? found.file);
        out.push({
          key,
          kind: t.kind,
          order: out.length + 1,
          package: t.package,
          file: found.file,
          version: insp.version,
          dist_tag: t.tag,
          after: keys.filter((k) => targets[k]!.kind === "github-release"),
        });
      } else {
        if (!(t.manifest in files.digests)) return no("artifact_not_requested", t.manifest);
        out.push({ key, kind: t.kind, order: out.length + 1, manifest: t.manifest, tags: t.tags });
      }
    }
    return { ok: true, plan: { targets: out } };
  }

  /**
   * Publishes to each declared target, in the explicit order of publishOrder. Before each: an incident freeze stops it. A
   * target already done is not repeated. Whatever happens is recorded and audited, never a credential.
   */
  /**
   * After a publish job ran through the release proxy: makes sure every compat npm and GitHub
   * target is really published, from the lane's own record of what it signed. A GitHub draft the
   * job filled is checked asset by asset against the attested digests and then published (any
   * asset that is missing or differs is replaced from the verified bytes first); an npm version
   * that is already there is accepted only if its integrity is the approved one, and published
   * by the lane if the job did not. An image has no lane-side step: the proxy pinned its manifest.
   */
  async finalize(a: { orgId: string; projectId: string; runId: string }): Promise<TargetResult[]> {
    const scope = { orgId: a.orgId, projectId: a.projectId };
    const approved = this.#o.attest.approvedRelease(a);
    if (!approved) return [{ target: "*", state: "refused", reason: "not_approved" }];
    const req = (await listReleaseRequests(this.#o.db, scope, 200))
      .filter((r) => r.runId === a.runId && r.status === "signed" && r.dryRun !== true)
      .at(-1);
    if (!req) return [{ target: "*", state: "refused", reason: "no_signed_request" }];
    const tag = await this.#o.forge.tagCommit(approved.repo, approved.tag);
    if (!tag.found || tag.sha !== approved.sha)
      return [{ target: "*", state: "refused", reason: "tag_moved" }];
    const digests = this.#o.attest.attestedDigests({
      ...scope,
      repo: approved.repo,
      tag: approved.tag,
    });
    const results = await this.#publish(
      req,
      scope,
      { repo: approved.repo, sha: approved.sha, digests, envelope: approved.envelope },
      true,
    );
    // Done: every target is published or was already. From here the release cannot be registered
    // with the proxy again (a re-run of finalize still resumes a failed target, since a failed
    // one leaves it open).
    if (results.every((r) => r.state === "published" || r.state === "already")) {
      this.#o.attest.markFinalized(a, (this.#o.now ?? Date.now)());
    }
    return results;
  }

  async #publish(
    req: ReleaseRequest,
    scope: { orgId: string; projectId: string },
    v: {
      repo: string;
      sha: string;
      digests: Record<string, string>;
      envelope: unknown;
    },
    ensureCompat = false,
    given?: ReleaseFiles,
  ): Promise<TargetResult[]> {
    const w = this.#o.publish;
    const targets = this.#o.attest.publishTargets(scope.orgId, scope.projectId);
    if (!w || Object.keys(targets).length === 0) return [];
    // The signed files: the ones the signing pass unpacked, or (finalize, a later run) unpacked
    // again now from the same artifacts, which must give exactly the digests that were attested.
    let own: ReleaseFiles | undefined;
    let files = given;
    if (!files) {
      const opened = await ReleaseFiles.open({
        bytes: this.#o.bytes,
        runId: req.runId,
        names: JSON.parse(req.artifacts) as string[],
        unpackRoot: this.#o.unpackRoot ?? join(tmpdir(), "turntable-release-unpack"),
      });
      if (opened.ok) {
        own = opened.files;
        const same = (x: Record<string, string>, y: Record<string, string>): boolean =>
          Object.keys(x).length === Object.keys(y).length &&
          Object.keys(x).every((k) => x[k] === y[k]);
        // Other files than the ones attested: nothing is read from them.
        if (same(own.digests, v.digests)) files = own;
      }
    }
    try {
      return await this.#publishTo(req, scope, v, ensureCompat, files);
    } finally {
      await own?.dispose();
    }
  }

  async #publishTo(
    req: ReleaseRequest,
    scope: { orgId: string; projectId: string },
    v: {
      repo: string;
      sha: string;
      digests: Record<string, string>;
      envelope: unknown;
    },
    ensureCompat: boolean,
    files: ReleaseFiles | undefined,
  ): Promise<TargetResult[]> {
    const w = this.#o.publish;
    const targets = this.#o.attest.publishTargets(scope.orgId, scope.projectId);
    const keys = publishOrder(targets);
    if (!w || keys.length === 0) return [];
    const now = this.#o.now ?? Date.now;
    const id = { orgId: scope.orgId, projectId: scope.projectId, repo: v.repo, tag: req.tag };
    const ctx = {
      scope,
      requestId: req.id,
      repo: v.repo,
      tag: req.tag,
      digests: v.digests,
      readBytes: async (name: string) => files?.readBytes(name),
      filesOf: (artifact: string) => files?.filesOf(artifact) ?? [],
      provenance: typeof v.envelope === "string" ? v.envelope : JSON.stringify(v.envelope),
      cosignatures: this.#o.attest
        .verifiedCosignatures({ ...scope, runId: req.runId })
        .map((c) => ({ outputName: c.outputName, signature: c.signature })),
    };
    const out: TargetResult[] = [];
    // Where signed bytes go is the lane's configuration. An approval given under an older version
    // of it (a target, the pin or a lane secret changed since) publishes nothing: approve again.
    const stale = this.#o.attest.configChangedSince({ ...scope, runId: req.runId });
    for (const key of keys) {
      const t = targets[key]!;
      const record = async (r: TargetResult): Promise<void> => {
        this.#o.attest.setPublishState(id, key, r.state, r.reason ?? null, now());
        await this.#audit(
          scope,
          req,
          `publish:${key}:${r.state}${r.reason ? `:${r.reason}` : ""}`,
          {
            target: key,
            kind: t.kind,
            ...(r.detail ? { detail: r.detail } : {}),
            ...r.facts,
          },
        );
        out.push(r);
      };
      if ((await getFreeze(this.#o.db, scope)).frozen) {
        await record({ target: key, state: "refused", reason: "frozen" });
        continue;
      }
      if (stale) {
        await record({ target: key, state: "refused", reason: CONFIG_CHANGED_REASON });
        continue;
      }
      const prior = this.#o.attest.publishState(id, key);
      if (prior && (prior.state === "published" || prior.state === "already")) {
        out.push({ target: key, state: "already", reason: "recorded" });
        continue;
      }
      // npm goes out only once the GitHub release of this release is published (or was): a release
      // that failed leaves npm untouched, never attempted.
      if (t.kind === "npm") {
        const gh = out.filter((r) => targets[r.target]?.kind === "github-release");
        const blocked = gh.filter((r) => r.state !== "published" && r.state !== "already");
        if (blocked.length > 0) {
          await record({
            target: key,
            state: "skipped",
            reason: "github_release_not_published",
            detail: `not attempted: ${blocked.map((r) => `${r.target} is ${r.state}`).join(", ")}`,
          });
          continue;
        }
      }
      // A target may name only artifacts this request asked for and the lane verified.
      const stray =
        t.kind === "npm"
          ? ctx.filesOf(t.artifact).length === 0 && !(t.artifact in v.digests)
            ? [t.artifact]
            : []
          : t.kind === "oci-image"
            ? [t.manifest].filter((n) => !(n in v.digests))
            : [
                ...t.assets.filter((n) => !(n in v.digests)),
                ...(t.assetArtifacts ?? []).filter((n) => ctx.filesOf(n).length === 0),
              ];
      if (stray.length > 0) {
        await record({
          target: key,
          state: "refused",
          reason: "artifact_not_requested",
          detail: stray.join(", "),
        });
        continue;
      }
      // A target the job publishes itself: the lane signed and approved it, and the release proxy
      // will hand the job the rules. An image has no strict path at all.
      if (t.mode === "compat" && !ensureCompat) {
        await record({ target: key, state: "pending", reason: "awaiting_job" });
        continue;
      }
      try {
        if (t.kind === "npm") {
          const registry = w.npmRegistry ?? "https://registry.npmjs.org";
          const token = await w.credentials.secret(
            scope,
            t.secret,
            new URL(registry).hostname,
            req.tag,
            req.id,
          );
          if (!token) {
            await record({ target: key, state: "failed", reason: "credential_unavailable" });
            continue;
          }
          await record(
            await publishNpm(key, t, ctx, token, {
              ...(w.npmRegistry ? { registry: w.npmRegistry } : {}),
              ...(w.fetch ? { fetch: w.fetch } : {}),
            }),
          );
        } else if (t.kind === "oci-image") {
          // After a compat push: what the registry holds must be the attested image, and our
          // provenance goes on it as a referrer.
          const cred = await w.credentials.secret(scope, t.secret, t.registry, req.tag, req.id);
          if (!cred) {
            await record({ target: key, state: "failed", reason: "credential_unavailable" });
            continue;
          }
          await record(
            await verifyOciImage(key, t, ctx, cred, {
              ...(w.fetch ? { fetch: w.fetch } : {}),
              // Only if a release target that carries the provenance really did, in this pass or
              // on record: published (assets read back and checked) or already there.
              releaseAssetFallback: out.some((r) => {
                const x = targets[r.target];
                return (
                  x?.kind === "github-release" &&
                  x.provenanceAsset !== null &&
                  (r.state === "published" || r.state === "already")
                );
              }),
            }),
          );
        } else {
          const token = await w.credentials.githubToken();
          if (!token) {
            await record({ target: key, state: "failed", reason: "credential_unavailable" });
            continue;
          }
          await record(
            await publishGithubRelease(key, t, ctx, token, {
              ...(w.githubApi ? { api: w.githubApi } : {}),
              ...(w.githubUploads ? { uploads: w.githubUploads } : {}),
              ...(w.fetch ? { fetch: w.fetch } : {}),
            }),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await record({
          target: key,
          state: "failed",
          reason: "exception",
          detail: msg.slice(0, 200),
        });
      }
    }
    return out;
  }

  #audit(
    scope: { orgId: string; projectId: string },
    req: ReleaseRequest,
    outcome: string,
    facts: Record<string, unknown>,
  ): Promise<void> {
    return appendAudit(this.#o.db, scope, {
      principalKind: "system",
      principalId: "release-lane",
      op: "release_lane",
      effect: "write",
      outcome,
      input: {
        request: req.id,
        run: req.runId,
        tag: req.tag,
        ...facts,
      },
    });
  }

  /** Polls for requests until stopped. One at a time. */
  start(intervalMs: number): void {
    this.#timer = setInterval(() => {
      if (this.#busy) return;
      this.#busy = true;
      void (async () => {
        try {
          while (await this.processNext()) {
            // keep going while there is work
          }
        } catch (e) {
          this.#o.log?.(`release lane failed: ${String(e)}`);
        } finally {
          this.#busy = false;
        }
      })();
    }, intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
