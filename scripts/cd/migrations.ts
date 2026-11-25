// Classifies database migrations for the CD preflight: a migration is ADDITIVE when running it
// against the schema the previous release expects cannot break that release (new tables, new
// indexes, new nullable or defaulted columns). Anything else holds the deploy for a maintainer.
// Pure functions plus an injected `git show`: no live calls.

export type Dialect = "sqlite" | "pg";

export const JOURNALS: Record<Dialect, { dir: string }> = {
  sqlite: { dir: "packages/core/drizzle" },
  pg: { dir: "packages/core/drizzle-pg" },
};

export interface StatementClass {
  sql: string;
  additive: boolean;
  reason: string;
}

export interface MigrationClass {
  dialect: Dialect;
  tag: string;
  additive: boolean;
  /** Why: the first blocking statement's reason, or a summary when all are additive. */
  reason: string;
  statements: StatementClass[];
}

const BREAKPOINT = "--> statement-breakpoint";

/** Removes `-- ...` line comments outside quotes. */
function stripComments(sql: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string;
    if (quote) {
      out += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
    } else out += c;
  }
  return out;
}

/** Splits on `;` outside quotes and parentheses. */
function splitSemicolons(sql: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (const c of sql) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === ";" && depth <= 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Drizzle's breakpoints first, then `;`. Comments and blanks are dropped. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  for (const chunk of sql.split(BREAKPOINT)) {
    for (const part of splitSemicolons(stripComments(chunk))) {
      const s = part.trim();
      if (s !== "") out.push(s);
    }
  }
  return out;
}

const IDENT = String.raw`(?:` + "`[^`]+`" + String.raw`|"[^"]+"|[A-Za-z_][\w$]*)`;
const unquote = (s: string): string => s.replace(/^[`"]|[`"]$/g, "");
const isRebuildTable = (name: string): boolean => unquote(name).startsWith("__new_");

/** `createdTables`: tables created earlier in the same migration (their constraints are safe). */
export function classifyStatement(
  raw: string,
  createdTables: Set<string> = new Set(),
): StatementClass {
  const sql = raw.trim();
  const flat = sql.replace(/\s+/g, " ");
  const no = (reason: string): StatementClass => ({ sql, additive: false, reason });
  const yes = (reason: string): StatementClass => ({ sql, additive: true, reason });

  let m = new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?(${IDENT})`, "i").exec(flat);
  if (m) {
    const name = m[1] as string;
    if (isRebuildTable(name)) return no(`table rebuild (creates ${unquote(name)})`);
    createdTables.add(unquote(name));
    return yes("creates a table");
  }
  if (/^CREATE (?:UNIQUE )?INDEX /i.test(flat)) {
    return yes(/^CREATE UNIQUE/i.test(flat) ? "creates a unique index" : "creates an index");
  }
  m = new RegExp(`^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?(${IDENT}) ADD (.*)$`, "i").exec(flat);
  if (m) {
    const table = unquote(m[1] as string);
    const rest = m[2] as string;
    if (/^(?:CONSTRAINT|FOREIGN KEY|CHECK|UNIQUE|PRIMARY KEY)\b/i.test(rest)) {
      if (createdTables.has(table) && /^(?:CONSTRAINT [^ ]+ )?FOREIGN KEY\b/i.test(rest)) {
        return yes(`adds a foreign key to ${table}, created in this migration`);
      }
      return no(`adds a constraint to existing table ${table}`);
    }
    const col = rest.replace(/^COLUMN /i, "").replace(/^IF NOT EXISTS /i, "");
    if (/\bPRIMARY KEY\b/i.test(col)) return no("adds a primary key column");
    if (/\bDEFAULT\b/i.test(col)) return yes("adds a defaulted column");
    if (!/\bNOT NULL\b/i.test(col)) return yes("adds a nullable column");
    return no("adds a NOT NULL column without a default");
  }
  const head = flat.split(" ").slice(0, 3).join(" ").toUpperCase();
  if (/^ALTER TABLE .* RENAME /i.test(flat)) return no("renames (table or column)");
  if (/^ALTER TABLE .* ALTER COLUMN /i.test(flat)) return no("alters a column");
  if (/^ALTER TABLE .* DROP /i.test(flat)) return no("drops a column or constraint");
  if (/^DROP /i.test(flat)) return no(`drops (${head})`);
  if (/^(INSERT|UPDATE|DELETE) /i.test(flat)) return no("changes data");
  if (/^PRAGMA /i.test(flat)) return no("PRAGMA");
  return no(`not recognized as additive (${head})`);
}

export function classifyMigration(dialect: Dialect, tag: string, sql: string): MigrationClass {
  const created = new Set<string>();
  const statements = splitStatements(sql).map((s) => classifyStatement(s, created));
  const blocker = statements.find((s) => !s.additive);
  return {
    dialect,
    tag,
    additive: blocker === undefined,
    reason: blocker
      ? blocker.reason
      : statements.length === 0
        ? "no statements"
        : `all ${statements.length} statements additive`,
    statements,
  };
}

/** Reads a file at a commit; null when it does not exist there. Injected (git show). */
export type GitShow = (sha: string, path: string) => Promise<string | null>;

interface Journal {
  entries: { tag: string }[];
}

async function journalTags(show: GitShow, sha: string, dialect: Dialect): Promise<string[] | null> {
  const text = await show(sha, `${JOURNALS[dialect].dir}/meta/_journal.json`);
  if (text === null) return null;
  return (JSON.parse(text) as Journal).entries.map((e) => e.tag);
}

/** Journal entries present at newSha and not at oldSha, per dialect, in journal order. */
export async function migrationsBetween(
  show: GitShow,
  oldSha: string,
  newSha: string,
): Promise<{ dialect: Dialect; tag: string }[]> {
  const out: { dialect: Dialect; tag: string }[] = [];
  for (const dialect of ["sqlite", "pg"] as const) {
    const before = new Set((await journalTags(show, oldSha, dialect)) ?? []);
    const after = await journalTags(show, newSha, dialect);
    if (after === null) throw new Error(`no ${dialect} journal at ${newSha}`);
    for (const tag of after) if (!before.has(tag)) out.push({ dialect, tag });
  }
  return out;
}

/** New migrations between two commits, each read at newSha and classified. */
export async function classifyBetween(
  show: GitShow,
  oldSha: string,
  newSha: string,
): Promise<MigrationClass[]> {
  const out: MigrationClass[] = [];
  for (const { dialect, tag } of await migrationsBetween(show, oldSha, newSha)) {
    const sql = await show(newSha, `${JOURNALS[dialect].dir}/${tag}.sql`);
    if (sql === null)
      throw new Error(`${dialect} migration ${tag} is in the journal but has no file`);
    out.push(classifyMigration(dialect, tag, sql));
  }
  return out;
}
