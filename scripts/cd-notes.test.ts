import { expect, test } from "bun:test";
import { classifyMigration } from "./cd/migrations";
import { buildNotes, buildRollbackNote, escapeMarkdown } from "./cd/notes";

test("escapes markdown control characters, newlines and mentions", () => {
  const e = escapeMarkdown("fix `x` *bold* [l](http://u) <b>\n# h @octocat | a_b ~~s~~ & more");
  expect(e).not.toContain("\n");
  expect(e).toBe(
    "fix \\`x\\` \\*bold\\* \\[l\\]\\(http\\://u\\) \\<b\\> \\# h &#64;octocat \\| a\\_b \\~\\~s\\~\\~ \\& more",
  );
});

test("builds the note with PRs, migrations with class, backup and timings", () => {
  const add = classifyMigration("sqlite", "0049_x", "CREATE TABLE `x` (`id` text);");
  const bad = classifyMigration("pg", "0020_y", 'DROP TABLE "y";');
  const text = buildNotes({
    deployedSha: "a".repeat(40),
    targetSha: "b".repeat(40),
    prs: [{ number: 12, title: "feat(core): add *things* @someone" }],
    migrations: [add, bad],
    backupId: "bk-123",
    timings: { backupMs: 61_000, deployMs: 120_000, verifyMs: 9_000 },
  });
  expect(text).toContain("Deployed `bbbbbbbbbbbb`");
  expect(text).toContain("Previous: `aaaaaaaaaaaa`");
  expect(text).toContain("- #12 feat\\(core\\)\\: add \\*things\\* &#64;someone");
  expect(text).toContain("- sqlite/`0049_x`: additive");
  expect(text).toContain("- pg/`0020_y`: NOT additive");
  expect(text).toContain("Backup: `bk-123`");
  expect(text).toContain("Timings: backup 61s, deploy 120s, verify 9s");
});

test("empty lists and a first deploy", () => {
  const text = buildNotes({
    deployedSha: null,
    targetSha: "c".repeat(40),
    prs: [],
    migrations: [],
    backupId: null,
    timings: {},
  });
  expect(text).toContain("Previous: none");
  expect(text.match(/None\./g)?.length).toBe(2);
  expect(text).toContain("Backup: none");
  expect(text).toContain("backup n/a");
});

const base = {
  deployedSha: "a".repeat(40),
  targetSha: "b".repeat(40),
  prs: [],
  migrations: [],
  backupId: null,
  timings: {},
};

test("the deploy note reports only a count of cut attempts, never names", () => {
  expect(buildNotes({ ...base, cutAttempts: 3 })).toContain(
    "3 running attempts were cut and requeued",
  );
  expect(buildNotes({ ...base, cutAttempts: 1 })).toContain(
    "1 running attempt was cut and requeued",
  );
  expect(buildNotes({ ...base, cutAttempts: 0 })).not.toContain("cut and requeued");
  expect(buildNotes(base)).not.toContain("cut and requeued");
  expect(Object.keys(base)).not.toContain("cutNames");
});

test("the rollback note names the target, the previous commit and the escaped reason", () => {
  const t = buildRollbackNote({
    targetSha: "b".repeat(40),
    previousSha: "a".repeat(40),
    reason: "timed out: healthz reports x @octocat\n# h",
  });
  expect(t).toBe(
    "rolled back `bbbbbbbbbbbb` to `aaaaaaaaaaaa`: timed out\\: healthz reports x &#64;octocat \\# h\n",
  );
});
