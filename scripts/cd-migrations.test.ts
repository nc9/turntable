import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyBetween,
  classifyMigration,
  classifyStatement,
  JOURNALS,
  migrationsBetween,
  splitStatements,
  type Dialect,
} from "./cd/migrations";

const root = join(import.meta.dir, "..");

// Pinned expectations for KNOWN migrations: [dialect, tag, additive, reason].
// Applied migrations are immutable, so these never change. The table need not list every
// file: new migrations are covered by the on-disk enumeration test below.
const TABLE: [Dialect, string, boolean, string][] = [
  ["sqlite", "0000_curvy_slayback", true, "all 1 statements additive"],
  ["sqlite", "0001_steep_makkari", true, "all 22 statements additive"],
  ["sqlite", "0002_adorable_bulldozer", true, "all 6 statements additive"],
  ["sqlite", "0003_wide_marrow", false, "PRAGMA"],
  ["sqlite", "0004_ordinary_mad_thinker", true, "all 9 statements additive"],
  ["sqlite", "0005_pink_maximus", true, "all 7 statements additive"],
  ["sqlite", "0006_fluffy_vance_astro", true, "all 6 statements additive"],
  ["sqlite", "0007_violet_starbolt", true, "all 5 statements additive"],
  ["sqlite", "0008_chief_ink", true, "all 1 statements additive"],
  ["sqlite", "0009_youthful_gladiator", true, "all 3 statements additive"],
  ["sqlite", "0010_loose_smasher", true, "all 5 statements additive"],
  ["sqlite", "0011_low_praxagora", true, "all 2 statements additive"],
  ["sqlite", "0012_redundant_newton_destine", true, "all 6 statements additive"],
  ["sqlite", "0013_clear_sugar_man", true, "all 2 statements additive"],
  ["sqlite", "0014_unique_living_mummy", true, "all 6 statements additive"],
  ["sqlite", "0015_dizzy_ronan", true, "all 8 statements additive"],
  ["sqlite", "0016_sharp_kabuki", true, "all 5 statements additive"],
  ["sqlite", "0017_lying_imperial_guard", true, "all 1 statements additive"],
  ["sqlite", "0018_clever_valkyrie", true, "all 13 statements additive"],
  ["sqlite", "0019_solid_next_avengers", true, "all 1 statements additive"],
  ["sqlite", "0020_medical_shen", true, "all 4 statements additive"],
  ["sqlite", "0021_minor_micromacro", true, "all 2 statements additive"],
  ["sqlite", "0022_complete_thor_girl", true, "all 2 statements additive"],
  ["sqlite", "0023_numerous_emma_frost", true, "all 1 statements additive"],
  ["sqlite", "0024_minor_warstar", true, "all 1 statements additive"],
  ["sqlite", "0025_magenta_magdalene", true, "all 5 statements additive"],
  ["sqlite", "0026_strong_famine", true, "all 4 statements additive"],
  ["sqlite", "0027_damp_sir_ram", true, "all 3 statements additive"],
  ["sqlite", "0028_cooing_texas_twister", true, "all 2 statements additive"],
  ["sqlite", "0029_lean_wendell_rand", true, "all 3 statements additive"],
  ["sqlite", "0030_instance_tokens", true, "all 2 statements additive"],
  ["sqlite", "0031_job_log_notices", true, "all 2 statements additive"],
  ["sqlite", "0032_quota_events", false, "PRAGMA"],
  ["sqlite", "0033_outbound_webhooks", false, "PRAGMA"],
  ["sqlite", "0034_oidc_audiences", true, "all 1 statements additive"],
  ["sqlite", "0035_project_sandbox_settings", true, "all 2 statements additive"],
  ["sqlite", "0036_skip_check_claim", true, "all 1 statements additive"],
  ["sqlite", "0037_untrusted_run_approval", false, "PRAGMA"],
  ["sqlite", "0038_settings_registry", true, "all 1 statements additive"],
  ["sqlite", "0039_untrusted_run_approval_to_settings", false, "changes data"],
  ["sqlite", "0040_attempt_sandbox_ttl", true, "all 1 statements additive"],
  ["sqlite", "0041_approval_policy_settings", false, "PRAGMA"],
  ["sqlite", "0042_regrant_reattach", true, "all 2 statements additive"],
  ["sqlite", "0043_dismissed_skips", true, "all 2 statements additive"],
  ["sqlite", "0044_web_sign_in", true, "all 8 statements additive"],
  ["sqlite", "0045_approver_github_user_id", true, "all 2 statements additive"],
  ["sqlite", "0046_approval_records_spent", true, "all 1 statements additive"],
  ["sqlite", "0047_attempt_infra_kind", true, "all 1 statements additive"],
  ["sqlite", "0048_onboardings", true, "all 2 statements additive"],
  ["pg", "0000_bored_absorbing_man", true, "all 112 statements additive"],
  ["pg", "0001_instance_tokens", true, "all 1 statements additive"],
  ["pg", "0002_job_log_notices", true, "all 3 statements additive"],
  ["pg", "0003_quota_events", false, "drops a column or constraint"],
  ["pg", "0004_outbound_webhooks", false, "drops a column or constraint"],
  ["pg", "0005_oidc_audiences", true, "all 1 statements additive"],
  ["pg", "0006_project_sandbox_settings", true, "all 2 statements additive"],
  ["pg", "0007_skip_check_claim", true, "all 1 statements additive"],
  ["pg", "0008_untrusted_run_approval", false, "adds a constraint to existing table api_tokens"],
  ["pg", "0009_settings_registry", true, "all 2 statements additive"],
  ["pg", "0010_untrusted_run_approval_to_settings", false, "changes data"],
  ["pg", "0011_attempt_sandbox_ttl", true, "all 1 statements additive"],
  ["pg", "0012_approval_policy_settings", false, "drops a column or constraint"],
  ["pg", "0013_regrant_reattach", true, "all 2 statements additive"],
  ["pg", "0014_dismissed_skips", true, "all 2 statements additive"],
  ["pg", "0015_web_sign_in", true, "all 10 statements additive"],
  ["pg", "0016_approver_github_user_id", true, "all 2 statements additive"],
  ["pg", "0017_approval_records_spent", true, "all 1 statements additive"],
  ["pg", "0018_attempt_infra_kind", true, "all 1 statements additive"],
  ["pg", "0019_onboardings", true, "all 3 statements additive"],
];

test("every migration file on disk classifies without error", () => {
  for (const dialect of ["sqlite", "pg"] as const) {
    const dir = join(root, JOURNALS[dialect].dir);
    const tags = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, -4))
      .sort();
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const c = classifyMigration(dialect, tag, readFileSync(join(dir, `${tag}.sql`), "utf8"));
      expect(typeof c.additive).toBe("boolean");
      expect(c.reason.length).toBeGreaterThan(0);
      expect(c.statements.length).toBeGreaterThan(0);
    }
  }
});

test("every pinned table entry still exists on disk", () => {
  for (const [dialect, tag] of TABLE) {
    const dir = join(root, JOURNALS[dialect].dir);
    expect(readdirSync(dir)).toContain(`${tag}.sql`);
  }
});

for (const [dialect, tag, additive, reason] of TABLE) {
  test(`${dialect} ${tag} is ${additive ? "additive" : "NOT additive"}`, () => {
    const sql = readFileSync(join(root, JOURNALS[dialect].dir, `${tag}.sql`), "utf8");
    const c = classifyMigration(dialect, tag, sql);
    expect(c.additive).toBe(additive);
    expect(c.reason).toBe(reason);
  });
}

test("the named anchors: 0033 rebuild is not additive, 0046 to 0048 are", () => {
  const by = (d: Dialect, p: string) => TABLE.find((r) => r[0] === d && r[1].startsWith(p));
  expect(by("sqlite", "0033")?.[2]).toBe(false);
  for (const p of ["0046_approval_records_spent", "0047_attempt_infra_kind", "0048_onboardings"]) {
    expect(by("sqlite", p)?.[2]).toBe(true);
  }
});

test("the SQLite rebuild pattern is not additive even though it starts with CREATE TABLE", () => {
  const sql = [
    "CREATE TABLE `__new_x` (`id` text PRIMARY KEY NOT NULL, `v` text);",
    "--> statement-breakpoint",
    "INSERT INTO `__new_x`(`id`) SELECT `id` FROM `x`;",
    "--> statement-breakpoint",
    "DROP TABLE `x`;",
    "--> statement-breakpoint",
    "ALTER TABLE `__new_x` RENAME TO `x`;",
  ].join("\n");
  const c = classifyMigration("sqlite", "9999_rebuild", sql);
  expect(c.additive).toBe(false);
  expect(c.statements.map((s) => s.additive)).toEqual([false, false, false, false]);
  expect(c.statements[0]?.reason).toContain("rebuild");
});

test("synthetic statements", () => {
  const add = (s: string) => classifyStatement(s).additive;
  expect(add("ALTER TABLE `t` ADD `c` text NOT NULL;")).toBe(false);
  expect(add('ALTER TABLE "t" ADD COLUMN "c" integer NOT NULL;')).toBe(false);
  expect(add("ALTER TABLE `t` ADD `c` integer DEFAULT 0 NOT NULL;")).toBe(true);
  expect(add('ALTER TABLE "t" ADD COLUMN "c" text DEFAULT \'a\' NOT NULL;')).toBe(true);
  expect(add("ALTER TABLE `t` ADD `c` text;")).toBe(true);
  expect(add("DROP INDEX `i`;")).toBe(false);
  expect(add("DROP TABLE `t`;")).toBe(false);
  expect(add("ALTER TABLE `t` RENAME COLUMN `a` TO `b`;")).toBe(false);
  expect(add('ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;')).toBe(false);
  expect(add('ALTER TABLE "t" DROP COLUMN "a";')).toBe(false);
  expect(add("UPDATE `t` SET `a` = 1;")).toBe(false);
  expect(add("DELETE FROM `t`;")).toBe(false);
  expect(add("PRAGMA foreign_keys=OFF;")).toBe(false);
  expect(add("CREATE TABLE `t` (`id` text PRIMARY KEY NOT NULL);")).toBe(true);
  expect(add("CREATE UNIQUE INDEX `i` ON `t` (`a`);")).toBe(true);
  expect(add("VACUUM;")).toBe(false);
});

test("a foreign key is additive only on a table created in the same migration", () => {
  const fk = 'ALTER TABLE "a" ADD CONSTRAINT "a_b_fk" FOREIGN KEY ("b") REFERENCES "b"("id");';
  expect(
    classifyMigration("pg", "x", `CREATE TABLE "a" ("b" text);--> statement-breakpoint\n${fk}`)
      .additive,
  ).toBe(true);
  expect(classifyMigration("pg", "x", fk).additive).toBe(false);
});

test("a file is additive only if every statement is", () => {
  const c = classifyMigration(
    "sqlite",
    "x",
    "CREATE TABLE `t` (`id` text);--> statement-breakpoint\nDROP INDEX `i`;",
  );
  expect(c.additive).toBe(false);
  expect(c.reason).toContain("drops");
});

test("splitStatements handles breakpoints, semicolons, comments and quoted semicolons", () => {
  expect(
    splitStatements(
      "-- note\nCREATE TABLE `t` (`a` text DEFAULT 'x;y');ALTER TABLE `t` ADD `b` text;--> statement-breakpoint\nCREATE INDEX `i` ON `t` (`a`);\n",
    ),
  ).toEqual([
    "CREATE TABLE `t` (`a` text DEFAULT 'x;y')",
    "ALTER TABLE `t` ADD `b` text",
    "CREATE INDEX `i` ON `t` (`a`)",
  ]);
});

function fakeGit(files: Record<string, string>) {
  return async (sha: string, path: string) => files[`${sha}:${path}`] ?? null;
}
const journal = (tags: string[]) => JSON.stringify({ entries: tags.map((tag) => ({ tag })) });

test("migrationsBetween returns the new journal entries per dialect", async () => {
  const show = fakeGit({
    [`old:${JOURNALS.sqlite.dir}/meta/_journal.json`]: journal(["0000_a"]),
    [`old:${JOURNALS.pg.dir}/meta/_journal.json`]: journal(["0000_a"]),
    [`new:${JOURNALS.sqlite.dir}/meta/_journal.json`]: journal(["0000_a", "0001_b"]),
    [`new:${JOURNALS.pg.dir}/meta/_journal.json`]: journal(["0000_a", "0001_b"]),
    [`new:${JOURNALS.sqlite.dir}/0001_b.sql`]: "CREATE TABLE `b` (`id` text);",
    [`new:${JOURNALS.pg.dir}/0001_b.sql`]: 'DROP TABLE "b";',
  });
  expect(await migrationsBetween(show, "old", "new")).toEqual([
    { dialect: "sqlite", tag: "0001_b" },
    { dialect: "pg", tag: "0001_b" },
  ]);
  const classes = await classifyBetween(show, "old", "new");
  expect(classes.map((c) => [c.dialect, c.additive])).toEqual([
    ["sqlite", true],
    ["pg", false],
  ]);
});
