import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatQuotas } from "../src/quotas/remote";
import { quotasCommand } from "../src/quotas/cli";
import { startServer } from "../src/server";
import { type Db, setOrgQuotas } from "../src/db";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let server: ReturnType<typeof startServer>;
let dir: string;
let base: string;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  server = startServer({ port: 0, host: "127.0.0.1", db });
  base = `http://127.0.0.1:${server.port}`;
  dir = mkdtempSync(join(tmpdir(), "ls-quotas-"));
});
afterEach(async () => {
  await server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const tokenFile = async (project = false) => {
  const f = join(dir, `${project ? "p" : "o"}.token`);
  writeFileSync(f, (await mintToken(db, project ? a.scope : { orgId: a.orgId }, "reader")).secret);
  chmodSync(f, 0o600);
  return f;
};

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (m: string) => void out.push(String(m));
  console.error = (m: string) => void err.push(String(m));
  try {
    return { code: await quotasCommand(args), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("get reads the org's quotas with an org-level reader token; a project-scoped token is refused", async () => {
  await setOrgQuotas(db, a.orgId, { maxConcurrent: 3 }, "test", Date.now());
  const common = ["get", "--url", base, "--org", a.slug];
  const got = await run([...common, "--token-file", await tokenFile()]);
  expect(got.code).toBe(0);
  expect(got.out).toContain("concurrent");
  expect(got.out).toContain("of 3");
  const json = await run([...common, "--token-file", await tokenFile(), "--json"]);
  expect(JSON.parse(json.out).limits.max_concurrent).toBe(3);
  const scoped = await run([...common, "--token-file", await tokenFile(true)]);
  expect(scoped.code).toBe(1);
  expect(scoped.err).toContain("org-level token");
});

test("get has no way to set, and bad arguments or a remote plain-http URL are refused", async () => {
  const f = await tokenFile();
  expect(
    (await run(["get", "--url", base, "--org", a.slug, "--token-file", f, "--max-concurrent", "9"]))
      .code,
  ).toBe(2);
  expect((await run(["get", "--org", a.slug])).err).toContain("required");
  expect(
    (await run(["get", "--url", "http://example.com", "--org", a.slug, "--token-file", f])).err,
  ).toContain("plain http");
});

test("the text output names a held limit", () => {
  const text = formatQuotas({
    limits: {},
    usage: [
      {
        metric: "log_bytes",
        used: 150,
        limit: 100,
        percent: 150,
        held: "new work is held: stored log bytes reached its limit (150 of 100)",
      },
      { metric: "concurrent", used: 1, limit: null, percent: null, held: null },
    ],
  });
  expect(text).toContain("150 of 100 (150%)");
  expect(text).toContain("held: new work is held");
  expect(text).toContain("no limit");
});
