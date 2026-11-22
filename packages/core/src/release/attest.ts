// The release lane's own record of artifact digests: a SQLite file that only the release process
// opens, apart from the main database. A digest is attested the first time the lane sees bytes
// that match what was recorded, and from then on a different digest for the same (org, run,
// artifact) is refused, whatever the main database now says. A compromised main process can edit
// its own rows, but not this file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AttestCheck =
  | { state: "new" }
  | { state: "same" }
  | { state: "mismatch"; attested: string };

export class AttestationStore {
  readonly #db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS attested_artifacts (
         org_id TEXT NOT NULL, run_id TEXT NOT NULL, name TEXT NOT NULL,
         sha256 TEXT NOT NULL, first_seen INTEGER NOT NULL,
         PRIMARY KEY (org_id, run_id, name))`,
    );
  }

  check(orgId: string, runId: string, name: string, sha256: string): AttestCheck {
    const row = this.#db
      .query<{ sha256: string }, [string, string, string]>(
        "SELECT sha256 FROM attested_artifacts WHERE org_id = ? AND run_id = ? AND name = ?",
      )
      .get(orgId, runId, name);
    if (!row) return { state: "new" };
    return row.sha256 === sha256 ? { state: "same" } : { state: "mismatch", attested: row.sha256 };
  }

  /** Records a digest the first time; never overwrites. */
  attest(orgId: string, runId: string, name: string, sha256: string, now: number): void {
    this.#db
      .query("INSERT OR IGNORE INTO attested_artifacts VALUES (?, ?, ?, ?, ?)")
      .run(orgId, runId, name, sha256, now);
  }

  close(): void {
    this.#db.close();
  }
}
