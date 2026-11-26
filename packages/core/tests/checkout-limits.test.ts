// Checkout size budgets as settings (#677): a project override raises one project's budgets, bounded
// by an instance ceiling; a full-history delivery has its own (larger) budgets; a budget hit is the
// named, never-retried infra kind `fetch_limit` with the limit, its value and the setting to change;
// and the memory claim: unpacked data is held in memory, so the budget is bounded by the child's
// memory ceiling (measured below).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { isRetryableInfra } from "@turntable/act-runner";
import { ResponseTooLargeError } from "@turntable/net";
import { createOrg, createProject, type Db, openDatabase } from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { checkCheckoutBudgets } from "../src/doctor/checks";
import type { DoctorInputs } from "../src/doctor/types";
import {
  budgetError,
  CheckoutLimitError,
  limitsFor,
  runCheckoutChild,
} from "../src/run/checkout-child";
import { effectiveCheckoutLimits } from "../src/run/checkout-limits";
import {
  budgetLimitOf,
  DEFAULT_FETCH_LIMITS,
  EXIT_FETCH_LIMIT,
  FetchLimitError,
  GitFetchError,
  readPack,
} from "../src/run/git-fetch";
import { fetchLimitOutcome } from "../src/scheduler/fetch-limit-outcome";
import { settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime, type SettingsRuntime } from "../src/settings/resolve";

const MIB = 1024 * 1024;
const tmp = mkdtempSync(join(tmpdir(), "tt-colimits-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let db: Db;
let rt: SettingsRuntime;
let env: DispatchEnv;
let secret: string;
let big: { orgId: string; projectId: string };
let other: { orgId: string; projectId: string };

beforeEach(async () => {
  db = openDatabase(":memory:");
  const o = await createOrg(db, { slug: "org-a", name: "org-a" });
  const p1 = await createProject(db, { orgId: o.id }, { slug: "big", name: "big" });
  const p2 = await createProject(db, { orgId: o.id }, { slug: "small", name: "small" });
  big = { orgId: o.id, projectId: p1.id };
  other = { orgId: o.id, projectId: p2.id };
  rt = createSettingsRuntime(settingsRegistry);
  env = { registry, db, allowInstance: true, settings: rt };
  secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});

const asInstance = (op: string, input: Record<string, unknown>) =>
  dispatch(env, { kind: "bearer", token: secret }, op, input);
const setProject = (key: string, value: unknown, project = "big") =>
  asInstance("instance_set_setting", { key, value, target_org: "org-a", target_project: project });

describe("per-project budgets", () => {
  test("with nothing set every project has the instance defaults", async () => {
    const l = await effectiveCheckoutLimits(rt, db, big.orgId, big.projectId);
    expect(l.maxPackBytes).toBe(128 * MIB);
    expect(l.maxInflatedBytes).toBe(512 * MIB);
    expect(l.maxTarballBytes).toBe(256 * MIB);
  });

  test("a project override raises the unpack budget for that project only", async () => {
    expect((await setProject("project_checkout_max_unpacked_mib", 2048)).ok).toBe(true);
    expect((await effectiveCheckoutLimits(rt, db, big.orgId, big.projectId)).maxInflatedBytes).toBe(
      2048 * MIB,
    );
    expect(
      (await effectiveCheckoutLimits(rt, db, other.orgId, other.projectId)).maxInflatedBytes,
    ).toBe(512 * MIB);
  });

  test("an override above the instance ceiling is refused, and one at it is accepted", async () => {
    const refused = await setProject("project_checkout_max_unpacked_mib", 4097);
    expect(!refused.ok && refused.error.code).toBe("invalid_input");
    expect(!refused.ok && refused.error.message).toMatch(
      /instance ceiling \(checkout_ceiling_unpacked_mib\)/,
    );
    expect((await setProject("project_checkout_max_unpacked_mib", 4096)).ok).toBe(true);
    // raising the ceiling is the instance administrator's, and then the larger value is accepted
    expect(
      (
        await asInstance("instance_set_setting", {
          key: "checkout_ceiling_unpacked_mib",
          value: 8192,
        })
      ).ok,
    ).toBe(true);
    expect((await setProject("project_checkout_max_unpacked_mib", 8000)).ok).toBe(true);
    expect((await effectiveCheckoutLimits(rt, db, big.orgId, big.projectId)).maxInflatedBytes).toBe(
      8000 * MIB,
    );
  });

  test("a stored value above a ceiling lowered later is clamped to it", async () => {
    expect((await setProject("project_checkout_max_pack_mib", 1000)).ok).toBe(true);
    expect(
      (await asInstance("instance_set_setting", { key: "checkout_ceiling_pack_mib", value: 300 }))
        .ok,
    ).toBe(true);
    expect((await effectiveCheckoutLimits(rt, db, big.orgId, big.projectId)).maxPackBytes).toBe(
      300 * MIB,
    );
  });

  test("an instance default applies to every project, and an environment value locks it", async () => {
    expect(
      (await asInstance("instance_set_setting", { key: "checkout_max_tarball_mib", value: 400 }))
        .ok,
    ).toBe(true);
    expect(
      (await effectiveCheckoutLimits(rt, db, other.orgId, other.projectId)).maxTarballBytes,
    ).toBe(400 * MIB);
    const locked = createSettingsRuntime(settingsRegistry, {
      TURNTABLE_CHECKOUT_MAX_UNPACKED_MIB: "600",
    });
    expect(
      (await effectiveCheckoutLimits(locked, db, big.orgId, big.projectId)).maxInflatedBytes,
    ).toBe(600 * MIB);
  });
});

describe("full-history budgets", () => {
  test("a full-history delivery has its own defaults, four times the shallow tree's", () => {
    const shallow = limitsFor({}, false);
    const full = limitsFor({}, true);
    expect(shallow.maxInflatedBytes).toBe(DEFAULT_FETCH_LIMITS.maxInflatedBytes);
    expect(full.maxPackBytes).toBe(4 * shallow.maxPackBytes);
    expect(full.maxInflatedBytes).toBe(4 * shallow.maxInflatedBytes);
    expect(full.maxTarballBytes).toBe(4 * shallow.maxTarballBytes);
    // everything else (per-object, tree, entry and delta guards) is the same
    expect(full.maxObjectBytes).toBe(shallow.maxObjectBytes);
    expect(full.maxTreeBytes).toBe(shallow.maxTreeBytes);
    expect(full.maxDeltaDepth).toBe(shallow.maxDeltaDepth);
  });

  test("the child is told the multiplied budgets, a project's included, only for full history", async () => {
    const cmd = [
      process.execPath,
      (() => {
        const f = join(tmp, "args.ts");
        writeFileSync(
          f,
          `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
writeFileSync(a[a.indexOf("--out") + 1] + ".args", JSON.stringify(a));
console.log("ok ${"a".repeat(40)} files=1 tarball=1");`,
        );
        return f;
      })(),
    ];
    const run = async (fullHistory: boolean) => {
      await runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha: "a".repeat(40),
        dir: join(tmp, "d"),
        out: join(tmp, "o.tgz"),
        command: cmd,
        fullHistory,
        config: { memoryMb: 0, limits: { maxInflatedBytes: 1024 * MIB } },
      });
      const a = JSON.parse(readFileSync(join(tmp, "o.tgz.args"), "utf8")) as string[];
      return JSON.parse(a[a.indexOf("--limits") + 1]!) as { maxInflatedBytes: number };
    };
    expect((await run(false)).maxInflatedBytes).toBe(1024 * MIB);
    expect((await run(true)).maxInflatedBytes).toBe(4096 * MIB);
  });
});

describe("the named infra kind fetch_limit", () => {
  const stubExit = (name: string, line: string, code: number): string[] => {
    const f = join(tmp, `${name}.ts`);
    writeFileSync(f, `console.error(${JSON.stringify(line)}); process.exit(${code});`);
    return [process.execPath, f];
  };
  const req = (command: string[], over: Record<string, unknown> = {}) => ({
    owner: "acme",
    repo: "web",
    sha: "a".repeat(40),
    dir: join(tmp, "d"),
    out: join(tmp, "o.tgz"),
    command,
    ...over,
  });

  test("a child over the unpacked budget ends as CheckoutLimitError naming the limit, value and settings", async () => {
    const cmd = stubExit(
      "over",
      "fetch-source failed: fetch_limit maxInflatedBytes",
      EXIT_FETCH_LIMIT,
    );
    const e = await runCheckoutChild(
      req(cmd, { config: { limits: { maxInflatedBytes: 700 * MIB } } }),
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CheckoutLimitError);
    const err = e as CheckoutLimitError;
    expect(err.limit).toBe("maxInflatedBytes");
    expect(err.mib).toBe(700);
    expect(err.message).toContain("unpacked limit of 700 MiB");
    expect(err.message).toContain("project_checkout_max_unpacked_mib");
    expect(err.message).toContain("checkout_max_unpacked_mib");
    expect(err.message).toContain("TURNTABLE_CHECKOUT_MAX_UNPACKED_MIB");
  });

  test("a full-history failure reports the multiplied value in force", async () => {
    const cmd = stubExit(
      "overfull",
      "fetch-source failed: fetch_limit maxPackBytes",
      EXIT_FETCH_LIMIT,
    );
    const e = (await runCheckoutChild(
      req(cmd, { fullHistory: true, config: { limits: { maxPackBytes: 100 * MIB } } }),
    ).catch((x: unknown) => x)) as CheckoutLimitError;
    expect(e).toBeInstanceOf(CheckoutLimitError);
    expect(e.mib).toBe(400);
    expect(e.message).toContain("pack limit of 400 MiB");
  });

  test("the attempt outcome is infra_error with kind fetch_limit, and it is never retried", () => {
    const e = new CheckoutLimitError("maxTarballBytes", 256, false);
    const o = fetchLimitOutcome(e)!;
    expect(o.outcome.state).toBe("infra_error");
    expect(o.outcome.infraKind).toBe("fetch_limit");
    expect(o.outcome.reason).toContain("tarball limit of 256 MiB");
    expect(o.logLine).toContain("project_checkout_max_tarball_mib");
    for (const klass of ["trusted_pr", "untrusted_pr", "protected", "release"]) {
      expect(isRetryableInfra("fetch_limit", klass)).toBe(false);
    }
    expect(fetchLimitOutcome(new Error("other"))).toBeUndefined();
  });

  test("the pack, unpack and tarball overruns are each recognised by name", () => {
    expect(budgetLimitOf(new FetchLimitError("maxInflatedBytes", "x"))).toBe("maxInflatedBytes");
    expect(budgetLimitOf(new Error("tar: the tarball is larger than the cap"))).toBe(
      "maxTarballBytes",
    );
    expect(budgetLimitOf(new Error("a tree object is too large"))).toBeUndefined();
  });

  test("readPack over its unpack budget throws the named error (the issue's delta case included)", () => {
    const blob = (n: number): { header: number[]; body: Uint8Array } => {
      const data = new Uint8Array(n).fill(7);
      const header: number[] = [];
      let b = (3 << 4) | (n & 15);
      let rest = Math.floor(n / 16);
      while (rest > 0) {
        header.push(b | 0x80);
        b = rest & 0x7f;
        rest = Math.floor(rest / 128);
      }
      header.push(b);
      return { header, body: new Uint8Array(deflateSync(data)) };
    };
    const head = Buffer.alloc(12);
    head.write("PACK", 0);
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(2, 8);
    const items = [blob(600), blob(601)];
    const body = Buffer.concat([head, ...items.flatMap((i) => [Buffer.from(i.header), i.body])]);
    const pack = Buffer.concat([body, createHash("sha1").update(body).digest()]);
    let caught: unknown;
    try {
      readPack(new Uint8Array(pack), { ...DEFAULT_FETCH_LIMITS, maxInflatedBytes: 1000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FetchLimitError);
    expect((caught as FetchLimitError).limit).toBe("maxInflatedBytes");
  });
});

describe("memory", () => {
  // The issue's premise, that objects are streamed to disk, does not hold: readPack keeps every
  // inflated object in memory, so the unpacked budget IS (about) the child's peak memory. That is
  // why the budget is bounded by the checkout child's memory ceiling (TURNTABLE_CHECKOUT_MAX_MEMORY_MIB,
  // 1536 by default) and why a memory kill is its own named limit.
  test("the inflated data of a pack is held in memory while it is read (measured)", () => {
    const each = 4 * MIB;
    const n = 8;
    const parts: Buffer[] = [];
    const head = Buffer.alloc(12);
    head.write("PACK", 0);
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(n, 8);
    parts.push(head);
    for (let i = 0; i < n; i += 1) {
      const data = new Uint8Array(each).fill(i + 1); // distinct objects, tiny once deflated
      const header: number[] = [];
      let b = (3 << 4) | (each & 15);
      let rest = Math.floor(each / 16);
      while (rest > 0) {
        header.push(b | 0x80);
        b = rest & 0x7f;
        rest = Math.floor(rest / 128);
      }
      header.push(b);
      parts.push(Buffer.from(header), deflateSync(data));
    }
    const body = Buffer.concat(parts);
    const pack = new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
    expect(pack.length).toBeLessThan(MIB); // the wire size is small, the unpacked size is not
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    const objects = readPack(pack, { ...DEFAULT_FETCH_LIMITS, maxInflatedBytes: 64 * MIB });
    const held = process.memoryUsage().rss - before;
    let total = 0;
    for (const o of objects.values()) total += o.data.length;
    expect(total).toBe(each * n);
    // held at least what was unpacked: the budget is a memory bound, not only a disk one
    expect(held).toBeGreaterThanOrEqual(total * 0.9);
  });
});

describe("the unpacked budget is clamped to the memory ceiling", () => {
  // effective = memory ceiling - pack budget - 256 MiB, for shallow and full history alike
  test("shallow: a budget above memory - pack - overhead is clamped", () => {
    const l = limitsFor({ maxInflatedBytes: 4096 * MIB }, false, 1536);
    expect(l.maxInflatedBytes).toBe((1536 - 128 - 256) * MIB);
  });

  test("full history: x4 pack counts against the ceiling, so the clamp is lower", () => {
    const l = limitsFor({}, true, 1536);
    expect(l.maxPackBytes).toBe(512 * MIB);
    expect(l.maxInflatedBytes).toBe((1536 - 512 - 256) * MIB);
  });

  test("a budget that fits is untouched, and memory 0 turns the clamp off", () => {
    expect(limitsFor({}, false, 1536).maxInflatedBytes).toBe(512 * MIB);
    expect(limitsFor({ maxInflatedBytes: 4096 * MIB }, false, 0).maxInflatedBytes).toBe(4096 * MIB);
  });

  test("doctor warns for a clamped configuration, naming both values", () => {
    const i = { env: { TURNTABLE_CHECKOUT_MAX_UNPACKED_MIB: "4096" } } as unknown as DoctorInputs;
    const c = checkCheckoutBudgets(i);
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("shallow unpacked 4096 MiB is clamped to 1152 MiB");
    expect(c.summary).toContain("1536 MiB memory ceiling");
    expect(c.summary).toContain("full-history unpacked 16384 MiB is clamped to 768 MiB");
  });

  test("doctor passes the defaults", () => {
    const c = checkCheckoutBudgets({ env: {} } as unknown as DoctorInputs);
    expect(c.status).toBe("pass");
  });
});

describe("round-4 review fixes", () => {
  const packOf = (items: Buffer[]): Uint8Array => {
    const head = Buffer.alloc(12);
    head.write("PACK", 0);
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(items.length, 8);
    const body = Buffer.concat([head, ...items]);
    return new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
  };
  const objHeader = (type: number, n: number): Buffer => {
    const out: number[] = [];
    let b = (type << 4) | (n & 15);
    let rest = Math.floor(n / 16);
    while (rest > 0) {
      out.push(b | 0x80);
      b = rest & 0x7f;
      rest = Math.floor(rest / 128);
    }
    out.push(b);
    return Buffer.from(out);
  };
  const varint = (n: number): number[] => {
    const out: number[] = [];
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
    return out;
  };

  test("a delta over the fixed per-object cap is the unnamed packed-object error", () => {
    const base = Buffer.from("hello");
    const baseOid = createHash("sha1")
      .update(Buffer.concat([Buffer.from(`blob ${base.length}\0`), base]))
      .digest();
    // the delta declares a 5000 byte result: over maxObjectBytes (1000), under maxInflatedBytes
    const delta = Buffer.from([...varint(base.length), ...varint(5000)]);
    const pack = packOf([
      Buffer.concat([objHeader(3, base.length), deflateSync(base)]),
      Buffer.concat([objHeader(7, delta.length), baseOid, deflateSync(delta)]),
    ]);
    const limits = { ...DEFAULT_FETCH_LIMITS, maxObjectBytes: 1000, maxInflatedBytes: 10_000 };
    const e = (() => {
      try {
        readPack(pack, limits);
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(GitFetchError);
    expect(e).not.toBeInstanceOf(FetchLimitError);
    expect((e as Error).message).toBe("a packed object is too large");
    expect(budgetLimitOf(e)).toBeUndefined();
    // a result within the object cap but over what is left of the unpack budget IS the named limit
    const tight = { ...limits, maxObjectBytes: 100_000, maxInflatedBytes: 1000 };
    const e2 = (() => {
      try {
        readPack(pack, tight);
      } catch (x) {
        return x;
      }
    })();
    expect(e2).toBeInstanceOf(FetchLimitError);
    expect((e2 as FetchLimitError).limit).toBe("maxInflatedBytes");
  });

  test("a clamped unpacked budget names the memory ceiling, not the unpacked settings", () => {
    // 1536 MiB memory, 128 MiB pack, 256 overhead: the 1152 MiB unpacked budget is cut to 1152
    const e = budgetError("maxInflatedBytes", { maxInflatedBytes: 2048 * MIB }, false, 1536);
    expect(e.clamped).toBe(true);
    expect(e.message).toContain("TURNTABLE_CHECKOUT_MAX_MEMORY_MIB");
    expect(e.message).not.toContain("checkout_max_unpacked_mib");
    expect(e.message).not.toContain("TURNTABLE_CHECKOUT_MAX_UNPACKED_MIB");
    expect(e.mib).toBe(
      Math.round(limitsFor({ maxInflatedBytes: 2048 * MIB }, false, 1536).maxInflatedBytes / MIB),
    );
    // not clamped: the unpacked settings, as before
    const ok = budgetError("maxInflatedBytes", { maxInflatedBytes: 512 * MIB }, false, 1536);
    expect(ok.clamped).toBe(false);
    expect(ok.message).toContain("project_checkout_max_unpacked_mib");
  });

  test("the child's own memory stop (exit 70) is the memory fetch_limit, full history included", async () => {
    const f = join(tmp, "rss.ts");
    writeFileSync(
      f,
      'console.error("fetch-source failed: the checkout used more than 10 MiB of memory"); process.exit(70);',
    );
    const e = (await runCheckoutChild({
      owner: "acme",
      repo: "web",
      sha: "a".repeat(40),
      dir: join(tmp, "d"),
      out: join(tmp, "o.tgz"),
      command: [process.execPath, f],
      fullHistory: true,
      config: { memoryMb: 1536 },
    }).catch((x: unknown) => x)) as CheckoutLimitError;
    expect(e).toBeInstanceOf(CheckoutLimitError);
    expect(e.limit).toBe("memory");
    expect(e.fullHistory).toBe(true);
    expect(e.message).toContain("TURNTABLE_CHECKOUT_MAX_MEMORY_MIB");
    expect(fetchLimitOutcome(e)?.outcome.infraKind).toBe("fetch_limit");
  });

  test("only the pack response's cap is the pack budget; a fixed small cap stays unnamed", () => {
    expect(budgetLimitOf(new ResponseTooLargeError(1024))).toBeUndefined();
    expect(budgetLimitOf(new FetchLimitError("maxPackBytes", "x"))).toBe("maxPackBytes");
  });
});
