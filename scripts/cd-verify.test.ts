import { expect, test } from "bun:test";
import { verifyDeploy, type VerifyDeps } from "./cd/verify";

const SHA = "d".repeat(40);

function fake(responses: (() => Response | Promise<Response>)[]) {
  let clock = 0;
  let i = 0;
  const urls: string[] = [];
  const deps: VerifyDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: async (url) => {
      urls.push(url);
      const r = responses[Math.min(i++, responses.length - 1)] as () =>
        Response | Promise<Response>;
      return r();
    },
  };
  return { deps, urls };
}
const health =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });

test("succeeds once healthz is ok and build_sha matches, after the old version drains", async () => {
  const f = fake([
    health({ ok: true, version: "0.1.0", build_sha: "e".repeat(40), draining: true }),
    () => {
      throw new Error("connection refused");
    },
    health({ ok: false }, 503),
    health({ ok: true, version: "0.1.0", build_sha: SHA }),
  ]);
  const r = await verifyDeploy(f.deps, { baseUrl: "https://x.example/", targetSha: SHA });
  expect(r.ok).toBe(true);
  expect(f.urls[0]).toBe("https://x.example/healthz");
});

test("accepts a version equal to the sha", async () => {
  const f = fake([health({ ok: true, version: SHA })]);
  expect((await verifyDeploy(f.deps, { baseUrl: "https://x.example", targetSha: SHA })).ok).toBe(
    true,
  );
});

test("a sha mismatch fails at the timeout and names both", async () => {
  const f = fake([health({ ok: true, version: "0.1.0", build_sha: "unknown" })]);
  const r = await verifyDeploy(f.deps, {
    baseUrl: "https://x.example",
    targetSha: SHA,
    timeoutMs: 30_000,
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain(`expected ${SHA}`);
});

test("a never-healthy instance times out", async () => {
  const f = fake([health({}, 502)]);
  const r = await verifyDeploy(f.deps, {
    baseUrl: "https://x.example",
    targetSha: SHA,
    timeoutMs: 10_000,
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("502");
});
