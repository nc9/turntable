// The release lane: takes release requests, and signs only what it has checked itself.
//
// A request is only a request. The lane trusts nothing in the main process's rows for what to
// sign. It re-asks the forge which commit the tag points at, re-reads the artifact bytes and
// recomputes their digests, and compares them with what it attested the first time it saw them,
// in a file the main process cannot reach. Only then does it call the signing service, which
// applies its own policy on top (release class, release ref, approvals).
import { createHash } from "node:crypto";
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
import type { AttestationStore } from "./attest";
import type { ArtifactBytes } from "./artifacts";
import type { ForgeFacts } from "./forge";
import { publishGithubRelease } from "./publish/github-release";
import { verifyOciImage } from "./publish/oci";
import { publishNpm } from "./publish/npm";
import type { PublishWiring, TargetResult } from "./publish/types";

/** The part of the signing service the lane uses (SigningService.signRelease). */
export interface ReleaseSigner {
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
  ): Promise<{ name: string; sha256: string }[]>;
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
  | "attestation_mismatch"
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
  now?: () => number;
  log?: (m: string) => void;
}

const TAG = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

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
      };
    }
  | { status: "refused"; reason: LaneDenial; detail?: string; facts: Record<string, unknown> };

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
      decision = await this.#decide(req, scope);
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
    // Signed: now publish what was verified. A failure here never un-signs the release; each
    // target says how it went, and a re-run of the same request resumes where it stopped.
    let published: TargetResult[] = [];
    if (decision.status === "signed") {
      // Remembered in the lane's own file: what the release proxy may hand rules out for.
      this.#o.attest.approveRelease(
        { ...scope, runId: req.runId },
        {
          repo: decision.verified.repo,
          tag: req.tag,
          sha: decision.verified.sha,
          artifacts: Object.keys(decision.verified.digests),
          envelope: JSON.stringify(decision.verified.envelope),
        },
        now(),
      );
      try {
        published = await this.#publish(req, scope, decision.verified);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        published = [
          { target: "*", state: "failed", reason: "publish_error", detail: msg.slice(0, 200) },
        ];
        await this.#audit(scope, req, "error:publish_error", { detail: msg.slice(0, 200) });
      }
    }
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
        "pin the project's repository with `longshore release pin-repo`",
      );
    if (run.repo.toLowerCase() !== pinned)
      return refuse("repo_mismatch", `the project is pinned to ${pinned}`);
    if (run.ref !== `refs/tags/${req.tag}`) return refuse("ref_mismatch", `run ref is ${run.ref}`);

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
    const missing = names.filter((n) => !byName.has(n));
    if (missing.length > 0) return refuse("artifact_not_recorded", missing.join(", "));

    const digests: Record<string, string> = {};
    for (const name of names) {
      const bytes = await this.#o.bytes.read(req.runId, name);
      if (!bytes) return refuse("artifact_bytes_missing", name);
      const actual = sha256(bytes);
      digests[name] = actual;
      facts.digests = digests;
      // The bytes must be what the build recorded...
      if (actual !== byName.get(name)) return refuse("digest_mismatch", name);
    }
    // ...and what this lane attested for this TAG before, in a store the main process cannot
    // write. Keyed by the release identity, not the run: a new run for an attested tag gets no
    // fresh first sight, and a tag is never signed twice with different digests.
    const identity = { orgId: scope.orgId, projectId: scope.projectId, repo: pinned, tag: req.tag };
    const c = this.#o.attest.checkRelease(identity, digests);
    if (c.state === "mismatch") return refuse("attestation_mismatch", c.why);
    const now = (this.#o.now ?? Date.now)();
    this.#o.attest.attestRelease(identity, digests, now);

    if ((await getFreeze(this.#o.db, scope)).frozen) return refuse("frozen");

    // The service signs exactly what was verified here: the commit the forge confirmed, the
    // pinned repository and the digests computed from the bytes. If a row changed since, it
    // refuses; and what comes back must be exactly these subjects.
    const subjects = names.map((name) => ({ name, sha256: digests[name]! }));
    const out = await this.#o.signer.signRelease(scope, {
      runId: req.runId,
      artifacts: names,
      verified: { sha: tag.sha, repo: pinned, ref: `refs/tags/${req.tag}`, subjects },
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
    return {
      status: "signed",
      result: { keyid: out.keyid, envelope: out.envelope, subjects: out.subjects },
      facts,
      verified: { repo: pinned, sha: tag.sha, digests, envelope: out.envelope },
    };
  }

  /**
   * Publishes to each declared target, in key order. Before each: an incident freeze stops it. A
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
      .filter((r) => r.runId === a.runId && r.status === "signed")
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
  ): Promise<TargetResult[]> {
    const w = this.#o.publish;
    const targets = this.#o.attest.publishTargets(scope.orgId, scope.projectId);
    // Images last: whether their provenance could go on a release asset depends on what happened
    // to the release targets in this same pass.
    const keys = Object.keys(targets).toSorted(
      (a, b) => Number(targets[a]!.kind === "oci-image") - Number(targets[b]!.kind === "oci-image"),
    );
    if (!w || keys.length === 0) return [];
    const now = this.#o.now ?? Date.now;
    const id = { orgId: scope.orgId, projectId: scope.projectId, repo: v.repo, tag: req.tag };
    const ctx = {
      scope,
      requestId: req.id,
      repo: v.repo,
      tag: req.tag,
      digests: v.digests,
      readBytes: (name: string) => this.#o.bytes.read(req.runId, name),
      provenance: typeof v.envelope === "string" ? v.envelope : JSON.stringify(v.envelope),
    };
    const out: TargetResult[] = [];
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
      const prior = this.#o.attest.publishState(id, key);
      if (prior && (prior.state === "published" || prior.state === "already")) {
        out.push({ target: key, state: "already", reason: "recorded" });
        continue;
      }
      // A target may name only artifacts this request asked for and the lane verified.
      const named =
        t.kind === "npm" ? [t.artifact] : t.kind === "oci-image" ? [t.manifest] : t.assets;
      const stray = named.filter((n) => !(n in v.digests));
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
