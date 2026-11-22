import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrg, openDatabase, setGithubApp } from "../src/db";
import { SECRET_WEBHOOK } from "../src/github/app-auth";
import { loadMasterKey } from "../src/secrets/crypto";
import { SecretStore } from "../src/secrets/store";
import { sign } from "./github-helpers";

const MAIN = join(import.meta.dir, "../src/main.ts");
const tmp = mkdtempSync(join(tmpdir(), "ls-gh-serve-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", "run", MAIN, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: tmp, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err, code };
}

describe("keys init and the webhook endpoint through the real server", () => {
  test("keys init writes a 0600 key, never prints it, and refuses to overwrite", async () => {
    const f = join(tmp, "k", "master.key");
    const r = await run(["keys", "init", "--file", f]);
    expect(r.code).toBe(0);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(r.out + r.err).not.toContain(loadMasterKey(f).toString("hex"));
    expect((await run(["keys", "init", "--file", f])).code).not.toBe(0);
  });

  test("a signed delivery is accepted, a forged one is not, and the route needs a master key", async () => {
    const keyFile = join(tmp, "serve.key");
    await run(["keys", "init", "--file", keyFile]);
    const data = join(tmp, "data");
    const db = openDatabase(join(data, "longshore.db"));
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    await setGithubApp(
      db,
      { orgId: org.id },
      {
        appId: "42",
        slug: "x",
        name: "x",
        ownerLogin: "acme",
        htmlUrl: "https://github.com/apps/x",
        clientId: "c",
      },
    );
    await new SecretStore(db, loadMasterKey(keyFile)).set(
      org.id,
      SECRET_WEBHOOK,
      "serve-test-webhook-secret",
    );
    db.close();

    const s = Bun.spawn(["bun", "run", MAIN, "serve", "--port", "0", "--data-dir", data], {
      env: { PATH: process.env.PATH ?? "", HOME: tmp, LONGSHORE_MASTER_KEY_FILE: keyFile },
      stdout: "pipe",
      stderr: "pipe",
    });
    let log = "";
    const reader = s.stdout.getReader();
    let port = 0;
    while (!port) {
      const { value, done } = await reader.read();
      if (done) break;
      log += new TextDecoder().decode(value);
      port = Number(/listening on http:\/\/[^:]+:(\d+)/.exec(log)?.[1] ?? 0);
    }
    try {
      const body = JSON.stringify({ zen: "hello" });
      const post = (sig: string) =>
        fetch(`http://127.0.0.1:${port}/api/v1/webhooks/github`, {
          method: "POST",
          headers: {
            "x-github-event": "ping",
            "x-github-delivery": crypto.randomUUID(),
            "x-hub-signature-256": sig,
          },
          body,
        });
      expect((await post(sign("serve-test-webhook-secret", body))).status).toBe(202);
      expect((await post(sign("wrong", body))).status).toBe(401);
    } finally {
      s.kill("SIGTERM");
      await s.exited;
    }

    // Without a master key the route is not mounted: the REST API answers (401, no token).
    const s2 = Bun.spawn(["bun", "run", MAIN, "serve", "--port", "0", "--data-dir", data], {
      env: { PATH: process.env.PATH ?? "", HOME: tmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    let log2 = "";
    const r2 = s2.stdout.getReader();
    let port2 = 0;
    while (!port2) {
      const { value, done } = await r2.read();
      if (done) break;
      log2 += new TextDecoder().decode(value);
      port2 = Number(/listening on http:\/\/[^:]+:(\d+)/.exec(log2)?.[1] ?? 0);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/api/v1/webhooks/github`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).not.toBe(202);
    } finally {
      s2.kill("SIGTERM");
      await s2.exited;
    }
  }, 60_000);
});
