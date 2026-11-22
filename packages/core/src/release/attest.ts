// The release lane's own record of artifact digests: a SQLite file that only the release process
// opens, apart from the main database. A digest is attested the first time the lane sees bytes
// that match what was recorded, and from then on a different digest for the same (org, run,
// artifact) is refused, whatever the main database now says. A compromised main process can edit
// its own rows, but not this file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseTarget } from "./publish/config";
import type { PublishTarget } from "./publish/types";

/** How long an approval can be registered with the proxy: a publish job starts soon after, or not at all. */
export const APPROVAL_TTL_MS = 6 * 3_600_000;

export type AttestCheck = { state: "new" } | { state: "same" } | { state: "mismatch"; why: string };

export class AttestationStore {
  readonly #db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    // Keyed by the release identity, not by the run: a second run for the same tag does not get a
    // fresh first sight of its artifacts.
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS attested_releases (
         org_id TEXT NOT NULL, project_id TEXT NOT NULL, repo TEXT NOT NULL, tag TEXT NOT NULL,
         name TEXT NOT NULL, sha256 TEXT NOT NULL, first_seen INTEGER NOT NULL,
         PRIMARY KEY (org_id, project_id, repo, tag, name))`,
    );
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS publish_targets (
         org_id TEXT NOT NULL, project_id TEXT NOT NULL, key TEXT NOT NULL,
         config TEXT NOT NULL, set_at INTEGER NOT NULL, PRIMARY KEY (org_id, project_id, key))`,
    );
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS publish_state (
         org_id TEXT NOT NULL, project_id TEXT NOT NULL, repo TEXT NOT NULL, tag TEXT NOT NULL,
         target TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, updated INTEGER NOT NULL,
         PRIMARY KEY (org_id, project_id, repo, tag, target))`,
    );
    // Written by the lane when it signs: the only thing the release proxy trusts to hand out rules.
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS approved_releases (
         org_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, repo TEXT NOT NULL,
         tag TEXT NOT NULL, sha TEXT NOT NULL, artifacts TEXT NOT NULL, approved_at INTEGER NOT NULL,
         envelope TEXT, expires_at INTEGER, finalized_at INTEGER,
         PRIMARY KEY (org_id, project_id, run_id))`,
    );
    // A file made before approvals expired and could be finalized: add the columns. A row without
    // an expiry is treated as approved_at plus the default window.
    const cols = this.#db
      .query<{ name: string }, []>("PRAGMA table_info(approved_releases)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("expires_at"))
      this.#db.run("ALTER TABLE approved_releases ADD COLUMN expires_at INTEGER");
    if (!cols.includes("finalized_at"))
      this.#db.run("ALTER TABLE approved_releases ADD COLUMN finalized_at INTEGER");
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS pinned_repos (
         org_id TEXT NOT NULL, project_id TEXT NOT NULL, repo TEXT NOT NULL,
         pinned_at INTEGER NOT NULL, PRIMARY KEY (org_id, project_id))`,
    );
  }

  /**
   * The project's publish declaration, set by the operator in this file. A pull request cannot
   * touch it, and neither can the main process.
   */
  setPublishTarget(
    orgId: string,
    projectId: string,
    key: string,
    target: PublishTarget,
    now: number,
  ): void {
    this.#db
      .query(
        "INSERT INTO publish_targets VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, key) DO UPDATE SET config = excluded.config, set_at = excluded.set_at",
      )
      .run(orgId, projectId, key, JSON.stringify(target), now);
  }

  removePublishTarget(orgId: string, projectId: string, key: string): boolean {
    return (
      this.#db
        .query("DELETE FROM publish_targets WHERE org_id = ? AND project_id = ? AND key = ?")
        .run(orgId, projectId, key).changes > 0
    );
  }

  /** The declared targets by key, validated again as they are read. A bad row is skipped, not trusted. */
  publishTargets(orgId: string, projectId: string): Record<string, PublishTarget> {
    const rows = this.#db
      .query<{ key: string; config: string }, [string, string]>(
        "SELECT key, config FROM publish_targets WHERE org_id = ? AND project_id = ? ORDER BY key",
      )
      .all(orgId, projectId);
    const out: Record<string, PublishTarget> = {};
    for (const r of rows) {
      try {
        out[r.key] = parseTarget(JSON.parse(r.config));
      } catch {
        // an unreadable declaration publishes nothing
      }
    }
    return out;
  }

  /** What happened to a target for a release: kept so a re-run resumes instead of repeating. */
  publishState(
    id: { orgId: string; projectId: string; repo: string; tag: string },
    target: string,
  ): { state: string; detail: string | null } | undefined {
    return (
      this.#db
        .query<{ state: string; detail: string | null }, [string, string, string, string, string]>(
          "SELECT state, detail FROM publish_state WHERE org_id = ? AND project_id = ? AND repo = ? AND tag = ? AND target = ?",
        )
        .get(id.orgId, id.projectId, id.repo.toLowerCase(), id.tag, target) ?? undefined
    );
  }

  setPublishState(
    id: { orgId: string; projectId: string; repo: string; tag: string },
    target: string,
    state: string,
    detail: string | null,
    now: number,
  ): void {
    this.#db
      .query(
        "INSERT INTO publish_state VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, project_id, repo, tag, target) DO UPDATE SET state = excluded.state, detail = excluded.detail, updated = excluded.updated",
      )
      .run(id.orgId, id.projectId, id.repo.toLowerCase(), id.tag, target, state, detail, now);
  }

  /**
   * Compares the digests of a release (a tag of the pinned repository) with what this lane
   * attested for it before. A tag already attested must come back with exactly the same set of
   * (name, digest) pairs: a different digest, an added artifact or a missing one is a mismatch.
   * Signing the same tag again with identical digests is fine.
   */
  checkRelease(
    id: { orgId: string; projectId: string; repo: string; tag: string },
    digests: Readonly<Record<string, string>>,
  ): AttestCheck {
    const rows = this.#db
      .query<{ name: string; sha256: string }, [string, string, string, string]>(
        "SELECT name, sha256 FROM attested_releases WHERE org_id = ? AND project_id = ? AND repo = ? AND tag = ?",
      )
      .all(id.orgId, id.projectId, id.repo.toLowerCase(), id.tag);
    if (rows.length === 0) return { state: "new" };
    const have = new Map(rows.map((r) => [r.name, r.sha256]));
    const names = Object.keys(digests);
    if (have.size !== names.length) {
      return { state: "mismatch", why: `${id.tag} was attested with a different set of artifacts` };
    }
    for (const n of names) {
      if (have.get(n) !== digests[n]) {
        return { state: "mismatch", why: `${n} differs from what was attested for ${id.tag}` };
      }
    }
    return { state: "same" };
  }

  /**
   * The lane signed this run's release: remembered in this file, for the release proxy. The
   * approval lasts `ttlMs`; after that, or once the release is finalized, the proxy hands out no
   * rules for it. Signing the same run again does not reopen a finalized release or move its
   * place in the order of approvals.
   */
  approveRelease(
    id: { orgId: string; projectId: string; runId: string },
    r: {
      repo: string;
      tag: string;
      sha: string;
      artifacts: readonly string[];
      /** The signed provenance, as JSON text, kept so a later publish attaches the lane's own. */
      envelope?: string;
    },
    now: number,
    ttlMs: number = APPROVAL_TTL_MS,
  ): void {
    this.#db
      .query(
        `INSERT INTO approved_releases
           (org_id, project_id, run_id, repo, tag, sha, artifacts, approved_at, envelope, expires_at, finalized_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (org_id, project_id, run_id) DO UPDATE SET
           repo = excluded.repo, tag = excluded.tag, sha = excluded.sha, artifacts = excluded.artifacts,
           envelope = excluded.envelope,
           approved_at = CASE WHEN finalized_at IS NULL THEN excluded.approved_at ELSE approved_at END,
           expires_at = CASE WHEN finalized_at IS NULL THEN excluded.expires_at ELSE expires_at END`,
      )
      .run(
        id.orgId,
        id.projectId,
        id.runId,
        r.repo.toLowerCase(),
        r.tag,
        r.sha,
        JSON.stringify(r.artifacts),
        now,
        r.envelope ?? null,
        now + ttlMs,
      );
  }

  /** The release is done (every target published): it can no longer be registered with the proxy. */
  markFinalized(id: { orgId: string; projectId: string; runId: string }, now: number): void {
    this.#db
      .query(
        "UPDATE approved_releases SET finalized_at = COALESCE(finalized_at, ?) WHERE org_id = ? AND project_id = ? AND run_id = ?",
      )
      .run(now, id.orgId, id.projectId, id.runId);
  }

  /**
   * True when no other approved release of the project was approved after this one: only the
   * newest may move a mutable name (an image's `latest`) forward.
   */
  isNewestApproved(id: { orgId: string; projectId: string; runId: string }): boolean {
    const mine = this.#db
      .query<{ approved_at: number; rowid: number }, [string, string, string]>(
        "SELECT approved_at, rowid FROM approved_releases WHERE org_id = ? AND project_id = ? AND run_id = ?",
      )
      .get(id.orgId, id.projectId, id.runId);
    if (!mine) return false;
    const newer = this.#db
      .query<{ n: number }, [string, string, string, number, number, number]>(
        `SELECT count(*) AS n FROM approved_releases
         WHERE org_id = ? AND project_id = ? AND run_id != ?
           AND (approved_at > ? OR (approved_at = ? AND rowid > ?))`,
      )
      .get(id.orgId, id.projectId, id.runId, mine.approved_at, mine.approved_at, mine.rowid);
    return (newer?.n ?? 0) === 0;
  }

  approvedRelease(id: { orgId: string; projectId: string; runId: string }):
    | {
        repo: string;
        tag: string;
        sha: string;
        artifacts: string[];
        envelope: string | undefined;
        approvedAt: number;
        expiresAt: number;
        finalizedAt: number | undefined;
      }
    | undefined {
    const row = this.#db
      .query<
        {
          repo: string;
          tag: string;
          sha: string;
          artifacts: string;
          envelope: string | null;
          approved_at: number;
          expires_at: number | null;
          finalized_at: number | null;
        },
        [string, string, string]
      >(
        "SELECT repo, tag, sha, artifacts, envelope, approved_at, expires_at, finalized_at FROM approved_releases WHERE org_id = ? AND project_id = ? AND run_id = ?",
      )
      .get(id.orgId, id.projectId, id.runId);
    return row
      ? {
          repo: row.repo,
          tag: row.tag,
          sha: row.sha,
          artifacts: JSON.parse(row.artifacts) as string[],
          envelope: row.envelope ?? undefined,
          approvedAt: row.approved_at,
          expiresAt: row.expires_at ?? row.approved_at + APPROVAL_TTL_MS,
          finalizedAt: row.finalized_at ?? undefined,
        }
      : undefined;
  }

  /** The digests attested for a release, by artifact name. */
  attestedDigests(id: {
    orgId: string;
    projectId: string;
    repo: string;
    tag: string;
  }): Record<string, string> {
    const rows = this.#db
      .query<{ name: string; sha256: string }, [string, string, string, string]>(
        "SELECT name, sha256 FROM attested_releases WHERE org_id = ? AND project_id = ? AND repo = ? AND tag = ?",
      )
      .all(id.orgId, id.projectId, id.repo.toLowerCase(), id.tag);
    return Object.fromEntries(rows.map((r) => [r.name, r.sha256]));
  }

  /** Records the digests of a release the first time; never overwrites. */
  attestRelease(
    id: { orgId: string; projectId: string; repo: string; tag: string },
    digests: Readonly<Record<string, string>>,
    now: number,
  ): void {
    for (const [name, sha] of Object.entries(digests)) {
      this.#db
        .query("INSERT OR IGNORE INTO attested_releases VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id.orgId, id.projectId, id.repo.toLowerCase(), id.tag, name, sha, now);
    }
  }

  /**
   * Which repository a project releases from, set by the operator in the lane's own file. The
   * lane asks the forge about THIS repository, never about whichever one a run row names.
   */
  pinRepo(orgId: string, projectId: string, repo: string, now: number): void {
    this.#db
      .query(
        "INSERT INTO pinned_repos VALUES (?, ?, ?, ?) ON CONFLICT (org_id, project_id) DO UPDATE SET repo = excluded.repo, pinned_at = excluded.pinned_at",
      )
      .run(orgId, projectId, repo.toLowerCase(), now);
  }

  pinnedRepo(orgId: string, projectId: string): string | undefined {
    return this.#db
      .query<{ repo: string }, [string, string]>(
        "SELECT repo FROM pinned_repos WHERE org_id = ? AND project_id = ?",
      )
      .get(orgId, projectId)?.repo;
  }

  close(): void {
    this.#db.close();
  }
}
