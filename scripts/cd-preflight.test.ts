import { expect, test } from "bun:test";
import { JOURNALS } from "./cd/migrations";
import { isPipelinePath, preflight, type PreflightDeps } from "./cd/preflight";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const journal = (tags: string[]) => JSON.stringify({ entries: tags.map((tag) => ({ tag })) });

function deps(o: {
  deployed?: string | null;
  newest?: string;
  changed?: string[];
  sql?: string;
}): PreflightDeps {
  const files: Record<string, string> = {
    [`${OLD}:${JOURNALS.sqlite.dir}/meta/_journal.json`]: journal(["0000_a"]),
    [`${OLD}:${JOURNALS.pg.dir}/meta/_journal.json`]: journal(["0000_a"]),
    [`${NEW}:${JOURNALS.sqlite.dir}/meta/_journal.json`]: journal(
      o.sql ? ["0000_a", "0001_b"] : ["0000_a"],
    ),
    [`${NEW}:${JOURNALS.pg.dir}/meta/_journal.json`]: journal(["0000_a"]),
  };
  if (o.sql) files[`${NEW}:${JOURNALS.sqlite.dir}/0001_b.sql`] = o.sql;
  return {
    show: async (sha, path) => files[`${sha}:${path}`] ?? null,
    changedFiles: async () => o.changed ?? [],
    github: {
      lastDeployedSha: async () => (o.deployed === undefined ? OLD : o.deployed),
      newestGreenMainSha: async () => o.newest ?? NEW,
    },
  };
}
const input = { targetSha: NEW, ciResult: "success" };

test("happy path with an additive migration deploys", async () => {
  const r = await preflight(
    deps({ sql: "CREATE TABLE `b` (`id` text);", changed: ["README.md"] }),
    input,
  );
  expect(r.deploy).toBe(true);
  expect(r.held).toEqual([]);
  expect(r.migrations.map((m) => [m.tag, m.additive])).toEqual([["0001_b", true]]);
});

test("a non-additive migration holds", async () => {
  const r = await preflight(deps({ sql: "DROP TABLE `b`;" }), input);
  expect(r.deploy).toBe(false);
  expect(r.held.join()).toContain("0001_b is not additive");
});

for (const path of [
  ".github/workflows/deploy.yml",
  "scripts/cd/backup.ts",
  "Dockerfile",
  "railway.toml",
  "railway.json",
]) {
  test(`a change to ${path} holds`, async () => {
    const r = await preflight(deps({ changed: ["README.md", path] }), input);
    expect(r.deploy).toBe(false);
    expect(r.held.join()).toContain(path);
  });
}

test("unrelated paths are not pipeline paths", () => {
  expect(isPipelinePath(".github/workflows/ci.yml")).toBe(false);
  expect(isPipelinePath("docs/railway.mdx")).toBe(false);
  expect(isPipelinePath("scripts/cdx.ts")).toBe(false);
});

test("a target that is not the newest green main sha holds", async () => {
  const r = await preflight(deps({ newest: "c".repeat(40) }), input);
  expect(r.deploy).toBe(false);
  expect(r.held.join()).toContain("not the newest green main sha");
});

test("failed CI holds", async () => {
  const r = await preflight(deps({}), { targetSha: NEW, ciResult: "failure" });
  expect(r.deploy).toBe(false);
  expect(r.held.join()).toContain("not success");
});

test("no previous deployment holds; the same sha does not redeploy", async () => {
  expect((await preflight(deps({ deployed: null }), input)).deploy).toBe(false);
  const same = await preflight(deps({ deployed: NEW }), input);
  expect(same.deploy).toBe(false);
  expect(same.held.join()).toContain("already deployed");
});

test("acknowledged (manual) lifts migration and pipeline holds but never CI or staleness", async () => {
  const d = deps({ sql: "DROP TABLE `b`;", changed: ["Dockerfile"] });
  expect((await preflight(d, { ...input, acknowledged: true })).deploy).toBe(true);
  expect(
    (await preflight(d, { targetSha: NEW, ciResult: "failure", acknowledged: true })).deploy,
  ).toBe(false);
  expect(
    (await preflight(deps({ newest: "c".repeat(40) }), { ...input, acknowledged: true })).deploy,
  ).toBe(false);
});
