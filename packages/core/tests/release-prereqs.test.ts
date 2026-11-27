import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findApiTokenByHash, getOrgBySlug, listApiTokens, openDatabase } from "../src/db";
import { bootstrapToken } from "../src/ops/bootstrap";
import { generateToken, hashToken } from "../src/ops/tokens";

const MAIN = join(import.meta.dir, "../src/main.ts");
const tmp = mkdtempSync(join(tmpdir(), "tt-prereq-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("bootstrapToken", () => {
  test("creates one operator token for an org with none, and only once", async () => {
    const db = openDatabase(":memory:");
    const secret = generateToken();
    const first = await bootstrapToken(db, { sha256: hashToken(secret) });
    expect(first).toMatchObject({ status: "created", org: "local" });
    const row = await findApiTokenByHash(db, hashToken(secret));
    expect(row).toMatchObject({ role: "operator", name: "bootstrap", createdBy: "bootstrap:env" });
    expect(row?.expiresAt).toBeGreaterThan(Date.now());

    const second = await bootstrapToken(db, { sha256: hashToken(generateToken()) });
    expect(second).toMatchObject({ status: "skipped" });
    const org = await getOrgBySlug(db, "local");
    expect(await listApiTokens(db, { orgId: org!.id })).toHaveLength(1);
  });

  test("a named org is created when missing", async () => {
    const db = openDatabase(":memory:");
    const r = await bootstrapToken(db, { sha256: hashToken(generateToken()), org: "acme" });
    expect(r).toMatchObject({ status: "created", org: "acme" });
    expect(await getOrgBySlug(db, "acme")).toBeDefined();
  });

  test("a hash that is not a sha256, or a bad org slug, is refused", async () => {
    const db = openDatabase(":memory:");
    await expect(bootstrapToken(db, { sha256: "not-a-hash" })).rejects.toThrow(/64 hex/);
    await expect(bootstrapToken(db, { sha256: "a".repeat(64), org: "Bad Org" })).rejects.toThrow(
      /slug/,
    );
  });
});

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  await s.stop(true);
  return p;
}

async function startServer(env: Record<string, string>, args: string[] = []) {
  const proc = Bun.spawn(
    ["bun", "run", MAIN, "serve", "--data-dir", join(tmp, `d-${Math.random()}`), ...args],
    {
      env: { PATH: process.env.PATH ?? "", HOME: tmp, TURNTABLE_ALLOW_ROOT: "1", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let log = "";
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + 20_000;
  let port = 0;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    log += dec.decode(value);
    const m = /listening on http:\/\/[^:]+:(\d+)/.exec(log);
    if (m) {
      port = Number(m[1]);
      break;
    }
  }
  return {
    port,
    log: () => log,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

describe("serve", () => {
  test("PORT is the default for --port, and --port wins", async () => {
    const p1 = await freePort();
    const a = await startServer({ PORT: String(p1) });
    expect(a.port).toBe(p1);
    expect((await fetch(`http://127.0.0.1:${p1}/healthz`)).status).toBe(200);
    await a.stop();

    const p2 = await freePort();
    const p3 = await freePort();
    const b = await startServer({ PORT: String(p2) }, ["--port", String(p3)]);
    expect(b.port).toBe(p3);
    await b.stop();
  }, 60_000);

  test("an invalid PORT is refused", async () => {
    const proc = Bun.spawn(["bun", "run", MAIN, "serve", "--data-dir", join(tmp, "bad")], {
      env: { PATH: process.env.PATH ?? "", HOME: tmp, PORT: "http" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain("invalid --port");
  });

  test("token generate prints the token and its hash; the bootstrap hash opens the API", async () => {
    const gen = Bun.spawn(["bun", "run", MAIN, "token", "generate"], {
      env: { PATH: process.env.PATH ?? "", HOME: tmp, TURNTABLE_ALLOW_ROOT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const token = (await new Response(gen.stdout).text()).trim();
    const err = await new Response(gen.stderr).text();
    expect(await gen.exited).toBe(0);
    expect(token.startsWith("tt_")).toBe(true);
    expect(err).toContain(`sha256: ${hashToken(token)}`);
    expect(err).not.toContain(token);

    const port = await freePort();
    const s = await startServer({
      PORT: String(port),
      TURNTABLE_BOOTSTRAP_TOKEN_SHA256: hashToken(token),
    });
    try {
      expect(s.log()).toContain("bootstrap: created an operator token for org local");
      expect(s.log()).not.toContain(token);
      expect((await fetch(`http://127.0.0.1:${port}/api/v1/runs`)).status).toBe(401);
      const ok = await fetch(`http://127.0.0.1:${port}/api/v1/runs`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(ok.status).toBe(200);
    } finally {
      await s.stop();
    }
  }, 60_000);
});
