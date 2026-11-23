import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  formatOpRef,
  loadOnePasswordConfig,
  OnePasswordBackend,
  parseOpRef,
} from "../src/secrets/backends/onepassword";
import { BackendError } from "../src/secrets/backends/types";
import { account, config, FakeOnePassword, randomToken } from "./op-fake";

const REF = "op://ci/deploy/token";
const VALUE = `v-${randomToken()}`;

function setup(over: Parameters<typeof config>[1] = {}, acct = account({ name: "ci" })) {
  const fake = new FakeOnePassword();
  fake.values.set(REF, VALUE);
  let now = 1_800_000_000_000;
  const logs: string[] = [];
  const backend = new OnePasswordBackend({
    config: config([acct], over),
    factory: fake.factory,
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { fake, backend, acct, logs, tick: (ms: number) => void (now += ms) };
}

describe("references", () => {
  test("parse op://vault/item/field and the sectioned form", () => {
    expect(parseOpRef("op://ci/deploy/token")).toEqual({
      vault: "ci",
      item: "deploy",
      field: "token",
    });
    expect(parseOpRef("op://My Vault/item/sec/field")).toEqual({
      vault: "My Vault",
      item: "item",
      section: "sec",
      field: "field",
    });
    expect(formatOpRef(parseOpRef("op://ci/i/s/f"))).toBe("op://ci/i/s/f");
  });
  test("refuses anything else", () => {
    for (const bad of [
      "ci/deploy/token",
      "op://ci/deploy",
      "op://a/b/c/d/e",
      "op://ci//f",
      "op://ci/i/f?attribute=otp",
    ]) {
      expect(() => parseOpRef(bad)).toThrow();
    }
  });
});

describe("operator config", () => {
  const json = (o: unknown) => ({ TURNTABLE_OP_CONFIG_JSON: JSON.stringify(o) });
  const acct = (over: object = {}) => ({
    name: "ci",
    tokenEnv: "OP_CI",
    vaults: ["ci"],
    orgs: ["o1"],
    trustClasses: ["protected"],
    ...over,
  });

  test("no config means no backend", () => {
    expect(loadOnePasswordConfig({})).toBeUndefined();
  });
  test("reads a token from an env var or a file, never from the config", () => {
    const t1 = randomToken();
    const t2 = randomToken();
    const cfg = loadOnePasswordConfig(
      {
        ...json({
          accounts: [
            acct(),
            acct({ name: "rel", tokenEnv: undefined, tokenFile: "/x/t", vaults: ["rel"] }),
          ],
        }),
        OP_CI: ` ${t1}\n`,
      },
      (p) => (p === "/x/t" ? `${t2}\n` : ""),
    );
    expect(cfg?.accounts.map((a) => a.token)).toEqual([t1, t2]);
    expect(cfg?.cacheTtlMs).toBe(300_000);
  });
  test("errors name the account and never a token", () => {
    const t = randomToken();
    const bad = (cfg: unknown, env: Record<string, string> = {}) => {
      try {
        loadOnePasswordConfig({ ...json(cfg), ...env, OP_CI: t });
      } catch (e) {
        expect(String(e)).not.toContain(t);
        return String(e);
      }
      throw new Error("expected an error");
    };
    expect(bad({ accounts: [acct({ tokenEnv: "MISSING" })] })).toContain("ci has no token");
    expect(bad({ accounts: [acct({ orgs: [] })] })).toContain("bound to orgs or projects");
    expect(bad({ accounts: [acct({ trustClasses: ["untrusted_pr"] })] })).toContain("invalid");
    expect(bad({ accounts: [acct(), acct({ name: "two" })] })).toContain("served by both");
    expect(bad({ accounts: [acct({ tokenFile: "/x" })] })).toContain("exactly one");
    expect(bad({ canary: "nope", accounts: [acct()] })).toBeTruthy();
  });
});

describe("the backend", () => {
  test("resolves once and serves the cache until the TTL, then reads again", async () => {
    const { fake, backend, tick } = setup();
    const ref = parseOpRef(REF);
    expect(await backend.resolve("ci", ref)).toBe(VALUE);
    expect(await backend.resolve("ci", ref)).toBe(VALUE);
    expect(fake.calls).toHaveLength(1);
    tick(299_000);
    await backend.resolve("ci", ref);
    expect(fake.calls).toHaveLength(1);
    // Rotated upstream; the cached value is still inside its TTL, so it is picked up after it.
    const rotated = `v2-${randomToken()}`;
    fake.values.set(REF, rotated);
    expect(await backend.resolve("ci", ref)).toBe(VALUE);
    tick(2_000);
    expect(await backend.resolve("ci", ref)).toBe(rotated);
    expect(fake.calls).toHaveLength(2);
  });

  test("the TTL is configurable, and 0 disables the cache", async () => {
    const { fake, backend } = setup({ cacheTtlMs: 0 });
    await backend.resolve("ci", parseOpRef(REF));
    await backend.resolve("ci", parseOpRef(REF));
    expect(fake.calls).toHaveLength(2);
  });

  test("concurrent misses share one read (single-flight)", async () => {
    const { fake, backend } = setup();
    let open!: () => void;
    fake.gate = new Promise<void>((r) => (open = r));
    const ref = parseOpRef(REF);
    const all = Promise.all(Array.from({ length: 20 }, () => backend.resolve("ci", ref)));
    await Bun.sleep(5);
    open();
    expect(new Set(await all)).toEqual(new Set([VALUE]));
    expect(fake.calls).toHaveLength(1);
  });

  test("a failed read is shared by the callers that waited on it, then retried by the next", async () => {
    const { fake, backend } = setup();
    fake.failWith = "outage";
    const ref = parseOpRef(REF);
    const rs = await Promise.allSettled([backend.resolve("ci", ref), backend.resolve("ci", ref)]);
    expect(rs.every((r) => r.status === "rejected")).toBe(true);
    fake.failWith = undefined;
    expect(await backend.resolve("ci", ref)).toBe(VALUE);
  });

  test("fails closed: outage and auth give an error, never a value; past-TTL values are not served", async () => {
    const { fake, backend, tick } = setup();
    const ref = parseOpRef(REF);
    await backend.resolve("ci", ref);
    tick(301_000);
    for (const kind of ["outage", "auth", "not_found"] as const) {
      fake.failWith = kind;
      const err = await backend.resolve("ci", ref).catch((e) => e);
      expect(err).toBeInstanceOf(BackendError);
      expect(err.kind).toBe(kind);
      expect(String(err.message)).not.toContain(VALUE);
    }
  });

  test("an empty value is refused", async () => {
    const { fake, backend } = setup();
    fake.values.set(REF, "");
    const err = await backend.resolve("ci", parseOpRef(REF)).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
  });

  test("a hung read times out as an outage", async () => {
    const { fake, backend } = setup();
    fake.gate = new Promise(() => {});
    const real = globalThis.setTimeout;
    // Shorten the 15 s timeout: the backend uses the global timer.
    (globalThis as { setTimeout: unknown }).setTimeout = (f: () => void, ms?: number) =>
      real(f, ms === 15_000 ? 10 : ms);
    try {
      const err = await backend.resolve("ci", parseOpRef(REF)).catch((e) => e);
      expect(err.kind).toBe("outage");
    } finally {
      globalThis.setTimeout = real;
    }
  });

  test("backs off after a 429: no read reaches 1Password while blocked, and the wait grows", async () => {
    const { fake, backend, tick, logs } = setup({}, account({ name: "ci", hourlyReadLimit: 1000 }));
    const ref = parseOpRef(REF);
    fake.failWith = "rate_limited";
    expect((await backend.resolve("ci", ref).catch((e) => e)).kind).toBe("rate_limited");
    expect(fake.calls).toHaveLength(1);
    fake.failWith = undefined;
    // Blocked locally: refused without a call, even though 1Password would now answer.
    expect((await backend.resolve("ci", ref).catch((e) => e)).kind).toBe("rate_limited");
    expect(fake.calls).toHaveLength(1);
    // Still limited after the wait: the next 429 doubles it, so 31 s later it is still blocked.
    fake.failWith = "rate_limited";
    tick(31_000);
    await backend.resolve("ci", ref).catch(() => {});
    expect(fake.calls).toHaveLength(2);
    fake.failWith = undefined;
    tick(31_000);
    expect((await backend.resolve("ci", ref).catch((e) => e)).kind).toBe("rate_limited");
    expect(fake.calls).toHaveLength(2);
    tick(30_000);
    expect(await backend.resolve("ci", ref)).toBe(VALUE);
    // The log names the account and the quota, and never a token or a value.
    const text = logs.join("\n");
    expect(text).toContain("account ci");
    expect(text).toContain("hourly reads left");
    expect(text).not.toContain(VALUE);
  });

  test("a configured hourly limit refuses reads locally once used up", async () => {
    const { fake, backend, tick } = setup({}, account({ name: "ci", hourlyReadLimit: 2 }));
    const ref = parseOpRef(REF);
    await backend.resolve("ci", ref);
    backend.refresh();
    await backend.resolve("ci", ref);
    backend.refresh();
    expect((await backend.resolve("ci", ref).catch((e) => e)).kind).toBe("rate_limited");
    expect(fake.calls).toHaveLength(2);
    tick(3_600_001);
    expect(await backend.resolve("ci", ref)).toBe(VALUE);
  });

  test("refresh drops the cache and reports how many", async () => {
    const { fake, backend } = setup();
    await backend.resolve("ci", parseOpRef(REF));
    expect(backend.refresh()).toBe(1);
    await backend.resolve("ci", parseOpRef(REF));
    expect(fake.calls).toHaveLength(2);
  });

  test("a read that started before a refresh does not repopulate the cache", async () => {
    const { fake, backend } = setup();
    let open!: () => void;
    fake.gate = new Promise<void>((r) => (open = r));
    const p = backend.resolve("ci", parseOpRef(REF));
    await Bun.sleep(5);
    backend.refresh();
    open();
    await p;
    fake.gate = undefined;
    await backend.resolve("ci", parseOpRef(REF));
    expect(fake.calls).toHaveLength(2);
  });

  test("health: canary reachability and quota, never the value", async () => {
    const { fake, backend } = setup({ canary: REF }, account({ name: "ci", hourlyReadLimit: 100 }));
    const ok = await backend.health();
    expect(ok.canary).toMatchObject({
      configured: true,
      account: "ci",
      reachable: true,
      error_kind: null,
    });
    expect(ok.accounts[0]).toMatchObject({ name: "ci", reads_last_hour: 1, remaining_hourly: 99 });
    fake.failWith = "outage";
    backend.refresh();
    const down = await backend.health();
    expect(down.canary).toMatchObject({ reachable: false, error_kind: "outage" });
    const all = JSON.stringify([ok, down]);
    expect(all).not.toContain(VALUE);
    for (const t of backend.tokens()) expect(all).not.toContain(t);
  });

  test("health: a canary in a vault no account serves is reported as unbound", async () => {
    const { backend } = setup({ canary: "op://other/i/f" });
    expect((await backend.health()).canary).toMatchObject({
      reachable: false,
      error_kind: "unbound",
    });
  });
});

describe("lazy loading", () => {
  test("the SDK is not loaded by importing the backend, or by building one; the vault never touches it", async () => {
    const script = join(import.meta.dir, "op-lazy-probe.ts");
    const p = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out.trim()).toBe("sdk-loaded=false");
  });
});
