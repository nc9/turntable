// Recorded artifacts and the project's signing settings. Part of the only code allowed to name
// tenant tables.
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { createHash } from "node:crypto";
import { ulid } from "../ulid";
import { parseTrust } from "./approve";
import { decideConsumption, lowerClass, type ConsumeDecision } from "../../artifacts/consume";
import { requireProject, type Scope, scoped } from "./scope";

export type ArtifactRow = typeof s.artifacts.$inferSelect;

const COLS = { orgId: s.artifacts.orgId, projectId: s.artifacts.projectId };

export class ArtifactConflict extends Error {}
/** The run or the attempt is not in the caller's scope, or the attempt is not the run's. */
export class ArtifactScopeError extends Error {}

/**
 * Records an artifact of a run. Idempotent for the same name and digest; a different digest under
 * a name already recorded is refused, never overwritten.
 */
export function recordArtifact(
  db: Db,
  scope: Scope,
  input: {
    runId: string;
    attemptId: string;
    name: string;
    sha256: string;
    size: number;
    /** When the control plane has the bytes it hashes them itself and the digest must match. */
    bytes?: Uint8Array;
  },
): Promise<ArtifactRow> {
  if (!/^[0-9a-f]{64}$/.test(input.sha256))
    return Promise.reject(new Error("sha256 must be 64 lower-case hex"));
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/.test(input.name)) {
    return Promise.reject(new Error("artifact name must be 1 to 200 plain characters"));
  }
  let sha256 = input.sha256;
  let digestSource = "reported";
  if (input.bytes) {
    const computed = createHash("sha256").update(input.bytes).digest("hex");
    if (computed !== input.sha256) {
      return Promise.reject(new ArtifactConflict("the bytes do not match the reported digest"));
    }
    sha256 = computed;
    digestSource = "computed";
  }
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    // Through the scoped tables: the run and the attempt must be in this org and project, and the
    // attempt must belong to this run. Anything else looks like "not found".
    const [run] = await tx.orm
      .select({ id: s.runs.id, trust: s.runs.trust, sha: s.runs.sha })
      .from(s.runs)
      .where(
        scoped(
          scope,
          { orgId: s.runs.orgId, projectId: s.runs.projectId },
          eq(s.runs.id, input.runId),
        ),
      )
      .limit(1);
    const [attempt] = await tx.orm
      .select({ id: s.jobAttempts.id, trustClass: s.jobAttempts.trustClass })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, input.attemptId),
          eq(s.jobs.runId, input.runId),
        ),
      )
      .limit(1);
    if (!run || !attempt) throw new ArtifactScopeError("no such run and attempt in scope");
    const [existing] = await tx.orm
      .select()
      .from(s.artifacts)
      .where(
        scoped(scope, COLS, eq(s.artifacts.runId, input.runId), eq(s.artifacts.name, input.name)),
      )
      .limit(1);
    if (existing) {
      if (existing.sha256 === sha256) return existing;
      throw new ArtifactConflict(`artifact ${input.name} is already recorded with another digest`);
    }
    const row = {
      id: ulid(),
      orgId: scope.orgId,
      projectId,
      runId: input.runId,
      attemptId: input.attemptId,
      name: input.name,
      sha256,
      size: input.size,
      // Provenance comes from the run's stored decision, never from the caller.
      // The class the attempt actually ran as, capped by its run's: an attempt can run lower than
      // its run (a re-run under another decision), and what it wrote is only as trusted as that.
      // Either one missing is the lowest class.
      klass: lowerClass(parseTrust(run)?.class, attempt.trustClass),
      runSha: run.sha ?? null,
      digestSource,
    };
    await tx.orm.insert(s.artifacts).values(row);
    const [out] = await tx.orm
      .select()
      .from(s.artifacts)
      .where(eq(s.artifacts.id, row.id))
      .limit(1);
    return out!;
  });
}

export function listRunArtifacts(db: Db, scope: Scope, runId: string): Promise<ArtifactRow[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.artifacts)
      .where(scoped(scope, COLS, eq(s.artifacts.runId, runId)))
      .orderBy(asc(s.artifacts.name)),
  );
}

export function getRunArtifactsByName(
  db: Db,
  scope: Scope,
  runId: string,
  names: readonly string[],
): Promise<ArtifactRow[]> {
  if (names.length === 0) return Promise.resolve([]);
  return db.run((h) =>
    h.orm
      .select()
      .from(s.artifacts)
      .where(
        and(
          scoped(scope, COLS, eq(s.artifacts.runId, runId)),
          inArray(s.artifacts.name, [...names]),
        ),
      ),
  );
}

export type ArtifactSource = { runId: string; name: string };
export type ResolvedArtifact = {
  source: ArtifactSource;
  decision: ConsumeDecision;
  /** The recorded provenance, when the artifact exists in scope. */
  artifact?: ArtifactRow;
};

/**
 * Decides, per source, whether a run may consume an artifact recorded by a run of this project.
 * The consumer's class comes from its stored trust decision. `quarantine` names the sources the
 * consumer explicitly asked to receive from a lower class. Unknown artifacts are denied, and so
 * is anything outside the caller's tenant (the lookup is scoped).
 */
export async function resolveArtifactConsumption(
  db: Db,
  scope: Scope,
  consumerRunId: string | { klass: string },
  sources: readonly ArtifactSource[],
  quarantine: readonly ArtifactSource[] = [],
): Promise<ResolvedArtifact[]> {
  // A consumer is a run (its class from its stored decision) or, to ask "may a build of this
  // class take it", a class by name.
  const run =
    typeof consumerRunId !== "string"
      ? [{ trust: JSON.stringify({ class: consumerRunId.klass, workflowHash: "" }) }]
      : await db.run((h) =>
          h.orm
            .select({ trust: s.runs.trust })
            .from(s.runs)
            .where(
              scoped(
                scope,
                { orgId: s.runs.orgId, projectId: s.runs.projectId },
                eq(s.runs.id, consumerRunId),
              ),
            )
            .limit(1),
        );
  const consumer = run[0] ? (parseTrust(run[0])?.class ?? "untrusted_pr") : undefined;
  const asked = new Set(quarantine.map((q) => `${q.runId}\n${q.name}`));
  const out: ResolvedArtifact[] = [];
  for (const source of sources) {
    if (consumer === undefined) {
      out.push({ source, decision: { decision: "deny", reason: "no such consumer run" } });
      continue;
    }
    const [artifact] = await getRunArtifactsByName(db, scope, source.runId, [source.name]);
    if (!artifact) {
      out.push({ source, decision: { decision: "deny", reason: "no such recorded artifact" } });
      continue;
    }
    out.push({
      source,
      artifact,
      decision: decideConsumption({
        consumer,
        producer: artifact.klass,
        explicit: asked.has(`${source.runId}\n${source.name}`),
      }),
    });
  }
  return out;
}

export interface ProjectSigning {
  /** Release ref patterns; the default when the project sets none. */
  releaseRefs: string[];
  /** The key reference, or null when the project cannot sign. */
  signingKey: string | null;
  /** The environment whose approval signing needs: the project's setting, `release` by default. */
  environment: string;
}

export const DEFAULT_SIGNING_ENVIRONMENT = "release";

export const DEFAULT_RELEASE_REF_PATTERNS: readonly string[] = ["refs/tags/v*"];

export function getProjectSigning(db: Db, scope: Scope): Promise<ProjectSigning> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({
        refs: s.projects.releaseRefs,
        key: s.projects.signingKey,
        env: s.projects.signingEnvironment,
      })
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    let refs: string[] = [...DEFAULT_RELEASE_REF_PATTERNS];
    if (row?.refs) {
      try {
        const parsed: unknown = JSON.parse(row.refs);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) refs = parsed;
      } catch {
        // an unreadable setting falls back to the default, which is the stricter reading
      }
    }
    return {
      releaseRefs: refs,
      signingKey: row?.key ?? null,
      environment: row?.env ?? DEFAULT_SIGNING_ENVIRONMENT,
    };
  });
}

export function setProjectSigning(
  db: Db,
  scope: Scope,
  patch: {
    releaseRefs?: readonly string[] | null;
    signingKey?: string | null;
    environment?: string | null;
  },
): Promise<void> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    await h.orm
      .update(s.projects)
      .set({
        ...(patch.releaseRefs === undefined
          ? {}
          : { releaseRefs: patch.releaseRefs === null ? null : JSON.stringify(patch.releaseRefs) }),
        ...(patch.signingKey === undefined ? {} : { signingKey: patch.signingKey }),
        ...(patch.environment === undefined ? {} : { signingEnvironment: patch.environment }),
      })
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)));
  });
}

/**
 * True when a project of ANOTHER org names this exact signing key setting. Used to keep a key
 * reference (a KMS key, say) from being shared between orgs: whichever org names it second is
 * refused, at policy time and again at signing time. Intentionally across orgs.
 */
export function signingKeyUsedByOtherOrg(db: Db, orgId: string, setting: string): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(and(eq(s.projects.signingKey, setting), ne(s.projects.orgId, orgId)))
      .limit(1);
    return rows.length > 0;
  });
}
