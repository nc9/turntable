import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarDirectory } from "@turntable/act-runner";
import type { SafeFetch } from "@turntable/net";
import { resolveDistTag } from "../src/release/publish/dist-tag";
import { parseTarget } from "../src/release/publish/config";
import { publishNpm } from "../src/release/publish/npm";
import type { NpmTarget, PublishContext } from "../src/release/publish/types";

const tmp = mkdtempSync(join(tmpdir(), "tt-disttag-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function run(version: string, tag: string) {
  const d = mkdtempSync(join(tmp, "pkg-"));
  mkdirSync(join(d, "package"));
  writeFileSync(join(d, "package", "package.json"), JSON.stringify({ name: "demo", version }));
  const bytes = await tarDirectory(d, ["package"]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const ctx: PublishContext = {
    scope: { orgId: "o", projectId: "p" },
    requestId: "r",
    repo: "acme/web",
    tag: `v${version}`,
    digests: { "demo.tgz": sha },
    readBytes: async () => bytes,
    filesOf: () => [],
    provenance: undefined,
  };
  const t: NpmTarget = {
    kind: "npm",
    mode: "strict",
    package: "demo",
    artifact: "demo.tgz",
    tag,
    access: "public",
    secret: "NPM_TOKEN",
  };
  let put: { "dist-tags": Record<string, string> } | undefined;
  const fetch = (async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      put = JSON.parse(init.body as string);
      return new Response("{}", { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as SafeFetch;
  const res = await publishNpm("npm", t, ctx, "token", {
    registry: "https://registry.test",
    fetch,
  });
  return { res, put };
}

describe("npm dist-tag auto", () => {
  test("beta, rc and latest by version", () => {
    expect(resolveDistTag("auto", "1.2.3-beta.4")).toEqual({ ok: true, tag: "beta" });
    expect(resolveDistTag("auto", "1.2.3-rc.1")).toEqual({ ok: true, tag: "rc" });
    expect(resolveDistTag("auto", "1.2.3-next")).toEqual({ ok: true, tag: "next" });
    expect(resolveDistTag("auto", "1.2.3")).toEqual({ ok: true, tag: "latest" });
    expect(resolveDistTag("auto", "1.2.3+build.5")).toEqual({ ok: true, tag: "latest" });
  });

  test("a prerelease never resolves to latest under auto", () => {
    for (const v of [
      "1.2.3-latest.1",
      "1.2.3-latest",
      "1.2.3-0",
      "1.2.3-1.beta",
      "1.2.3-Beta.1",
      "1.2.3-.x",
      "1.2.3--x",
      "1.2.3-rc_1".replace("_", "."),
    ]) {
      const r = resolveDistTag("auto", v);
      if (r.ok) expect(r.tag).not.toBe("latest");
      if (v === "1.2.3-latest.1" || v === "1.2.3-0" || v === "1.2.3-Beta.1")
        expect(r.ok).toBe(false);
    }
    expect(resolveDistTag("auto", "not-a-version").ok).toBe(false);
  });

  test("publishing: auto derives the dist-tag in the document", async () => {
    const b = await run("1.2.3-beta.4", "auto");
    expect(b.res.state).toBe("published");
    expect(b.put!["dist-tags"]).toEqual({ beta: "1.2.3-beta.4" });
    const s = await run("1.2.3", "auto");
    expect(s.put!["dist-tags"]).toEqual({ latest: "1.2.3" });
  });

  test("publishing: a prerelease is refused rather than sent to latest", async () => {
    const r = await run("1.2.3-latest.1", "auto");
    expect(r.res).toMatchObject({ state: "refused", reason: "bad_dist_tag" });
    expect(r.put).toBeUndefined();
    const n = await run("1.2.3-0", "auto");
    expect(n.res).toMatchObject({ state: "refused", reason: "bad_dist_tag" });
  });

  test("a static tag behaves as before, whatever the version", async () => {
    const a = await run("1.2.3-beta.4", "latest");
    expect(a.put!["dist-tags"]).toEqual({ latest: "1.2.3-beta.4" });
    const b = await run("1.2.3", "canary");
    expect(b.put!["dist-tags"]).toEqual({ canary: "1.2.3" });
    expect(resolveDistTag("Custom.Tag", "9.9.9")).toEqual({ ok: true, tag: "Custom.Tag" });
  });

  test("config accepts auto and still checks static tags", () => {
    const ok = { kind: "npm", package: "demo", artifact: "demo", secret: "NPM_TOKEN" };
    expect(parseTarget({ ...ok, tag: "auto" })).toMatchObject({ tag: "auto" });
    expect(parseTarget(ok)).toMatchObject({ tag: "latest" });
    expect(() => parseTarget({ ...ok, tag: "has space" })).toThrow();
  });
});
