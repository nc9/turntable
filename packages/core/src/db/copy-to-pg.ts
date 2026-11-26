// Copies a SQLite instance database into Postgres (#716), for the hosted move off SQLite.
//
// It runs inside a server that started on SQLite, so the schema modules and repos are the SQLite
// ones and cannot talk to the target. Everything here is raw SQL: the source is read through its
// bun:sqlite handle (read-only statements, the file is never written), the target through the
// driver behind a drizzle pg handle (Bun's SQL client, or PGlite in tests).
//
// Shape of a run:
//  1. migrate the target (idempotent, under the same advisory lock a booting server uses);
//  2. refuse a target that holds rows unless every copied table already equals the source;
//  3. copy table by table in foreign-key order, in batches, yielding between them;
//  4. reset identity sequences so the next generated id is above every copied one;
//  5. verify per-table counts and an order-independent checksum over primary keys, and walk
//     every audit chain on the target (links, hashes, checkpoint positions, head equal to source).
// A failed copy empties what it wrote, which is safe because step 2 proved the target was empty.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { walkChainPages } from "../audit/verify";
import { applyPgMigrations } from "./pg";
import { migrations } from "./migrations.pg.generated";
import type { AuditRow } from "./repos";

type PgOrm = PgDatabase<never, Record<string, unknown>>;
type Row = Record<string, unknown>;

/** A target: a drizzle pg handle and a way to close it. */
export type CopyTarget = { orm: PgOrm; close(): Promise<void> };

/** Test hook: how a URL becomes a target. The default connects with Bun's SQL client. */
let openTarget: (url: string) => Promise<CopyTarget> = async (url) => {
  const { drizzle } = await import("drizzle-orm/bun-sql");
  const orm = drizzle(url, { connection: { max: 2 } } as never);
  return {
    orm: orm as unknown as PgOrm,
    close: async () =>
      void (await (orm as unknown as { $client: { close(): Promise<void> } }).$client.close()),
  };
};
export function setCopyTargetOpener(fn: ((url: string) => Promise<CopyTarget>) | undefined): void {
  openTarget = fn ?? openTarget;
}
export const connectCopyTarget = (url: string): Promise<CopyTarget> => openTarget(url);

/** Runs one parameterised statement on the target's driver and returns its rows. */
async function query(orm: PgOrm, text: string, params: unknown[] = []): Promise<Row[]> {
  const c = (orm as unknown as { $client: Record<string, unknown> }).$client;
  if (typeof c.unsafe === "function") {
    return (await (c.unsafe as (t: string, p: unknown[]) => Promise<Row[]>)(text, params)) as Row[];
  }
  const r = await (c.query as (t: string, p: unknown[]) => Promise<{ rows: Row[] }>)(text, params);
  return r.rows;
}

const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export type TableReport = {
  table: string;
  source_rows: number;
  /** Rows the target held before this run. */
  target_rows: number;
  copied: number;
  checksum: string | null;
};

export type CopyOptions = {
  dryRun: boolean;
  /** Tables left out, e.g. the log tables once they live in the log store. */
  exclude: readonly string[];
  batchSize?: number;
  /** Called between batches; a real server yields to its event loop. */
  yieldNow?: () => Promise<void>;
};

export type CopyReport = {
  dry_run: boolean;
  /** `empty`, or `identical` when every copied table already equals the source. */
  target_state: "empty" | "identical";
  migrations_applied: string[];
  excluded: string[];
  tables: TableReport[];
  sequences: { table: string; column: string; next: number }[];
  audit: { orgs: number; entries: number } | null;
  verified: boolean;
};

export class CopyRefused extends Error {}

type Col = { name: string; pg: string };
type TableInfo = { name: string; pk: string[]; cols: Col[]; identity: string | null };

/** Tables of the SQLite file that carry data (not migration bookkeeping, not SQLite's own). */
function sourceTables(src: Database): string[] {
  return src
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_\\_%' escape '\\' order by name",
    )
    .all()
    .map((r) => r.name);
}

/** Parents before children, from the SQLite foreign keys; ties by name so the order is stable. */
export function fkOrder(src: Database, tables: readonly string[]): string[] {
  const set = new Set(tables);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const parents = src
      .query<{ table: string }, []>(`pragma foreign_key_list(${q(t)})`)
      .all()
      .map((f) => f.table)
      .filter((p) => p !== t);
    // a parent that is excluded cannot be satisfied by this copy: the child's rows would dangle
    for (const p of parents) {
      if (!set.has(p)) {
        throw new CopyRefused(`table ${t} references excluded table ${p}; exclude both or neither`);
      }
    }
    deps.set(t, new Set(parents));
  }
  const out: string[] = [];
  const left = new Set(tables);
  while (left.size > 0) {
    const ready = [...left].filter((t) => [...(deps.get(t) ?? [])].every((p) => !left.has(p)));
    if (ready.length === 0) throw new CopyRefused("the foreign keys form a cycle");
    ready.sort();
    for (const t of ready) {
      out.push(t);
      left.delete(t);
    }
  }
  return out;
}

async function describeTables(src: Database, orm: PgOrm, tables: string[]): Promise<TableInfo[]> {
  const out: TableInfo[] = [];
  for (const t of tables) {
    const info = src.query<{ name: string; pk: number }, []>(`pragma table_info(${q(t)})`).all();
    const target = await query(
      orm,
      "select column_name, data_type, is_identity, is_nullable, column_default from information_schema.columns where table_schema = current_schema() and table_name = $1",
      [t],
    );
    if (target.length === 0) throw new CopyRefused(`the target has no table ${t}`);
    const byName = new Map(target.map((r) => [String(r.column_name), r] as const));
    const cols: Col[] = [];
    for (const c of info) {
      const m = byName.get(c.name);
      if (!m) throw new CopyRefused(`the target table ${t} has no column ${c.name}`);
      cols.push({ name: c.name, pg: String(m.data_type) });
    }
    // The dialects number their migrations differently, so the schemas are compared by shape: a
    // target column the source lacks must be fillable by the database itself.
    const have = new Set(cols.map((c) => c.name));
    for (const r of target) {
      if (
        !have.has(String(r.column_name)) &&
        r.is_nullable === "NO" &&
        r.column_default === null &&
        r.is_identity !== "YES"
      ) {
        throw new CopyRefused(
          `the target table ${t} has a required column ${String(r.column_name)} the source lacks: start the source on this build first`,
        );
      }
    }
    const pk = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const id = target.find((r) => r.is_identity === "YES");
    out.push({
      name: t,
      pk: pk.length > 0 ? pk : cols.map((c) => c.name),
      cols,
      identity: id ? String(id.column_name) : null,
    });
  }
  return out;
}

/** One stored value, as the target's column type wants it. */
function toPg(v: unknown, pgType: string): unknown {
  if (v === null || v === undefined) return null;
  if (pgType === "boolean") return v === 1 || v === true || v === "1";
  if (pgType === "bytea") return v instanceof Uint8Array ? v : Buffer.from(String(v));
  return v;
}

const rowKey = (t: TableInfo, r: Row): string => t.pk.map((c) => String(r[c])).join("\u0000");

/** Order-independent: the sum of the rows' sha256 as 256-bit numbers. */
class Checksum {
  #sum = 0n;
  add(key: string): void {
    const h = createHash("sha256").update(key).digest("hex");
    this.#sum = (this.#sum + BigInt(`0x${h}`)) % (1n << 256n);
  }
  hex(): string {
    return this.#sum.toString(16).padStart(64, "0");
  }
}

function sourceStats(src: Database, t: TableInfo): { rows: number; checksum: string } {
  const cs = new Checksum();
  let rows = 0;
  let last = 0;
  const cols = t.pk.map(q).join(", ");
  for (;;) {
    const page = src
      .query<Row, [number]>(
        `select rowid as __rowid, ${cols} from ${q(t.name)} where rowid > ? order by rowid limit 5000`,
      )
      .all(last);
    if (page.length === 0) break;
    for (const r of page) cs.add(rowKey(t, r));
    rows += page.length;
    last = page.at(-1)!.__rowid as number;
  }
  return { rows, checksum: cs.hex() };
}

async function targetStats(orm: PgOrm, t: TableInfo): Promise<{ rows: number; checksum: string }> {
  const cs = new Checksum();
  let rows = 0;
  const cols = t.pk.map(q).join(", ");
  // Keyset on the primary key would need typed comparisons; a count then one streamed read per
  // chunk of 5000 by offset over a stable order is enough for a check that runs once.
  for (let offset = 0; ; offset += 5000) {
    const page = await query(
      orm,
      `select ${cols} from ${q(t.name)} order by ${cols} limit 5000 offset ${offset}`,
    );
    if (page.length === 0) break;
    for (const r of page) cs.add(rowKey(t, r));
    rows += page.length;
  }
  return { rows, checksum: cs.hex() };
}

const auditRowOf = (r: Row): AuditRow =>
  ({
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id ?? null,
    principalKind: r.principal_kind,
    principalId: r.principal_id,
    op: r.op,
    effect: r.effect,
    outcome: r.outcome,
    input: r.input,
    createdAt: Number(r.created_at),
    seq: r.seq === null ? null : Number(r.seq),
    prevHash: r.prev_hash ?? null,
    hash: r.hash ?? null,
  }) as AuditRow;

/** Walks every org's audit chain on the target and compares each head with the source's. */
async function verifyAuditOnTarget(
  src: Database,
  orm: PgOrm,
): Promise<{ orgs: number; entries: number }> {
  const orgs = src
    .query<{ org_id: string }, []>("select distinct org_id from audit_log where seq is not null")
    .all()
    .map((r) => r.org_id);
  let entries = 0;
  for (const orgId of orgs) {
    const walk = await walkChainPages(async (after, limit) =>
      (
        await query(
          orm,
          "select * from audit_log where org_id = $1 and seq > $2 order by seq asc limit $3",
          [orgId, after, limit],
        )
      ).map(auditRowOf),
    );
    if (walk.problems.length > 0) {
      throw new CopyRefused(
        `audit chain of org ${orgId} does not verify on the target: ${walk.problems[0]}`,
      );
    }
    const head = src
      .query<{ seq: number; hash: string }, [string]>(
        "select seq, hash from audit_log where org_id = ? and seq is not null order by seq desc limit 1",
      )
      .get(orgId);
    if (!head || walk.headSeq !== head.seq || walk.hashes.get(head.seq) !== head.hash) {
      throw new CopyRefused(`audit chain head of org ${orgId} differs between source and target`);
    }
    // each checkpoint must sit on the entry it signed
    const cps = await query(orm, "select seq, hash from audit_checkpoints where org_id = $1", [
      orgId,
    ]);
    for (const cp of cps) {
      if (walk.hashes.get(Number(cp.seq)) !== cp.hash) {
        throw new CopyRefused(
          `a checkpoint of org ${orgId} does not match its entry on the target`,
        );
      }
    }
    entries += walk.entries;
  }
  return { orgs: orgs.length, entries };
}

function batchRows(src: Database, t: TableInfo, after: number, limit: number): Row[] {
  return src
    .query<Row, [number]>(
      `select rowid as __rowid, * from ${q(t.name)} where rowid > ? order by rowid limit ${limit}`,
    )
    .all(after);
}

/**
 * Copies `src` into the target. `src` is only ever read. With `dryRun` the target is migrated and
 * checked, and nothing is copied. Throws `CopyRefused` with a fixed sentence for every refusal.
 */
export async function copySqliteToPg(
  src: Database,
  target: CopyTarget,
  opts: CopyOptions,
): Promise<CopyReport> {
  const { orm } = target;
  const yieldNow = opts.yieldNow ?? (() => new Promise<void>((r) => setImmediate(r)));
  const exclude = new Set(opts.exclude);
  const all = sourceTables(src);
  for (const e of exclude) {
    if (!all.includes(e)) throw new CopyRefused(`exclude_tables names an unknown table: ${e}`);
  }
  const names = fkOrder(
    src,
    all.filter((t) => !exclude.has(t)),
  );

  const applied = await applyPgMigrations(orm as never, migrations);
  const infos = await describeTables(src, orm, names);
  const reports: TableReport[] = [];
  let anyRows = false;
  let identical = true;
  for (const t of infos) {
    const s = sourceStats(src, t);
    const d = await targetStats(orm, t);
    if (d.rows > 0) anyRows = true;
    if (d.rows !== s.rows || d.checksum !== s.checksum) identical = false;
    reports.push({
      table: t.name,
      source_rows: s.rows,
      target_rows: d.rows,
      copied: 0,
      checksum: s.checksum,
    });
  }
  if (anyRows && !identical) {
    throw new CopyRefused(
      "the target already holds rows that differ from the source: use an empty database",
    );
  }
  const state: "empty" | "identical" = anyRows ? "identical" : "empty";
  const report: CopyReport = {
    dry_run: opts.dryRun,
    target_state: state,
    migrations_applied: applied,
    excluded: [...exclude].sort(),
    tables: reports,
    sequences: [],
    audit: null,
    verified: false,
  };
  if (opts.dryRun) return report;

  const size = opts.batchSize ?? 500;
  try {
    if (state === "empty") {
      for (const [i, t] of infos.entries()) {
        const per = Math.max(1, Math.min(size, Math.floor(30_000 / t.cols.length)));
        let after = 0;
        for (;;) {
          const rows = batchRows(src, t, after, per);
          if (rows.length === 0) break;
          const params: unknown[] = [];
          const tuples = rows.map((r) => {
            const ph = t.cols.map((c) => {
              params.push(toPg(r[c.name], c.pg));
              return `$${params.length}`;
            });
            return `(${ph.join(", ")})`;
          });
          await query(
            orm,
            `insert into ${q(t.name)} (${t.cols.map((c) => q(c.name)).join(", ")}) ${t.identity ? "overriding system value " : ""}values ${tuples.join(", ")}`,
            params,
          );
          reports[i]!.copied += rows.length;
          after = rows.at(-1)!.__rowid as number;
          await yieldNow();
        }
      }
    }
    for (const t of infos) {
      if (!t.identity) continue;
      const [m] = await query(
        orm,
        `select coalesce(max(${q(t.identity)}), 0) as m from ${q(t.name)}`,
      );
      const max = Number(m?.m ?? 0);
      await query(orm, `select setval(pg_get_serial_sequence($1, $2), $3, $4)`, [
        q(t.name),
        t.identity,
        Math.max(max, 1),
        max > 0,
      ]);
      report.sequences.push({ table: t.name, column: t.identity, next: max + 1 });
    }

    for (const [i, t] of infos.entries()) {
      const s = sourceStats(src, t);
      const d = await targetStats(orm, t);
      if (d.rows !== s.rows || d.checksum !== s.checksum) {
        throw new CopyRefused(
          `table ${t.name} does not match after the copy (counts or key checksum)`,
        );
      }
      reports[i]!.checksum = d.checksum;
    }
    if (names.includes("audit_log")) report.audit = await verifyAuditOnTarget(src, orm);
  } catch (err) {
    // a failed copy or check: the target was empty when this began, so emptying it restores that
    if (state === "empty") {
      for (const t of infos.toReversed())
        await query(orm, `delete from ${q(t.name)}`).catch(() => {});
    }
    throw err;
  }
  report.verified = true;
  return report;
}
