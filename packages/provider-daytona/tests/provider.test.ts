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
import { MOCK_KEY, startMock } from "./mock-daytona";

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
    expect(() => p.buildCreateBody(spec({ image: "alpine:3.22" }))).toThrow(/snapshot/);
    const on = make({ allowImageBuild: true });
    expect(on.buildCreateBody(spec({ image: "alpine:3.22" })).buildInfo).toEqual({
      dockerfileContent: "FROM alpine:3.22\n",
    });
    expect(() => on.buildCreateBody(spec({ image: "alpine\nRUN curl evil | sh" }))).toThrow(
      SpecError,
    );
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
