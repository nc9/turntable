import { expect, test } from "bun:test";
import { JOURNALS } from "./cd/migrations";
import {
  CHECK_NAME_FILE,
  MCP_TOOLS_FILE,
  OPENAPI_FILE,
  isPipelinePath,
  preflight,
  type PreflightDeps,
} from "./cd/preflight";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const journal = (tags: string[]) => JSON.stringify({ entries: tags.map((tag) => ({ tag })) });

const BASE_OPENAPI = { paths: {} };
const BASE_MCP: unknown[] = [];

function deps(o: {
  deployed?: string | null;
  newest?: string;
  changed?: string[];
  sql?: string;
  /** The agent-facing surface at the target; the deployed commit always has `BASE_*`. */
  newOpenapi?: unknown;
  newMcp?: unknown;
  newNames?: string;
}): PreflightDeps {
  const files: Record<string, string> = {
    [`${OLD}:${JOURNALS.sqlite.dir}/meta/_journal.json`]: journal(["0000_a"]),
    [`${OLD}:${JOURNALS.pg.dir}/meta/_journal.json`]: journal(["0000_a"]),
    [`${NEW}:${JOURNALS.sqlite.dir}/meta/_journal.json`]: journal(
      o.sql ? ["0000_a", "0001_b"] : ["0000_a"],
    ),
    [`${NEW}:${JOURNALS.pg.dir}/meta/_journal.json`]: journal(["0000_a"]),
  };
  files[`${OLD}:${OPENAPI_FILE}`] = JSON.stringify(BASE_OPENAPI);
  files[`${OLD}:${MCP_TOOLS_FILE}`] = JSON.stringify(BASE_MCP);
  files[`${OLD}:${CHECK_NAME_FILE}`] = "export const a = 1;";
  files[`${NEW}:${OPENAPI_FILE}`] = JSON.stringify(o.newOpenapi ?? BASE_OPENAPI);
  files[`${NEW}:${MCP_TOOLS_FILE}`] = JSON.stringify(o.newMcp ?? BASE_MCP);
  files[`${NEW}:${CHECK_NAME_FILE}`] = o.newNames ?? "export const a = 1;";
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

test("a change to the check-run name builder holds; an acknowledged run lifts it", async () => {
  const d = deps({ newNames: "export const a = 2;" });
  const r = await preflight(d, input);
  expect(r.deploy).toBe(false);
  expect(r.held.join()).toContain("check-run name builder changed");
  expect((await preflight(d, { ...input, acknowledged: true })).deploy).toBe(true);
});

test("a changed watched operation holds, an unwatched one does not", async () => {
  const op = (id: string, props: unknown) => ({
    paths: {
      [`/${id}`]: {
        get: {
          operationId: id,
          responses: {
            "200": {
              content: { "application/json": { schema: { type: "object", properties: props } } },
            },
          },
        },
      },
    },
  });
  const oldDoc = {
    paths: {
      ...op("list_runs", { id: { type: "string" } }).paths,
      ...op("whoami", { id: { type: "string" } }).paths,
    },
  };
  const newDoc = {
    paths: {
      ...op("list_runs", { id: { type: "string" } }).paths,
      ...op("whoami", { x: { type: "string" } }).paths,
    },
  };
  const base = deps({});
  const show = async (sha: string, path: string) =>
    path === OPENAPI_FILE ? JSON.stringify(sha === OLD ? oldDoc : newDoc) : base.show(sha, path);
  const r = await preflight({ ...base, show }, input);
  expect(r.deploy).toBe(true);
  const worse = { paths: op("list_runs", { x: { type: "string" } }).paths };
  const r2 = await preflight(
    {
      ...base,
      show: async (sha, path) =>
        path === OPENAPI_FILE ? JSON.stringify(sha === OLD ? oldDoc : worse) : base.show(sha, path),
    },
    input,
  );
  expect(r2.deploy).toBe(false);
  expect(r2.held.join()).toContain("list_runs");
});

test("a missing surface document at either commit holds", async () => {
  const base = deps({});
  const r = await preflight(
    {
      ...base,
      show: async (sha, path) =>
        sha === OLD && path === MCP_TOOLS_FILE ? null : base.show(sha, path),
    },
    input,
  );
  expect(r.deploy).toBe(false);
  expect(r.held.join()).toContain("cannot be compared");
});
