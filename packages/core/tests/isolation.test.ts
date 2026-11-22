import { expect, test } from "bun:test";
import { FakeWorld } from "@longshore/provider-sdk/testing";
import type { ProviderInfo } from "@longshore/provider-sdk";
import { isolationAtLeast, ISOLATION_ORDER } from "@longshore/provider-sdk";
import { requiredIsolation, trustOf, withIsolationPolicy } from "../src/scheduler/isolation";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";

const ok: AttemptOutcome = { state: "success", reason: "ok" };

function ctx(
  isolation: ProviderInfo["isolation"],
  opts: { approvalKind?: string | null; plan?: string | null } = {},
): AttemptContext {
  const world = new FakeWorld();
  const provider = world.provider();
  return {
    attempt: { id: "att1" },
    job: { id: "job1", approvalKind: opts.approvalKind ?? null },
    run: { id: "run1", plan: opts.plan ?? null },
    scope: { orgId: "o", projectId: "p" },
    provider: { ...provider, info: { ...provider.info, isolation, name: "testprov" } } as never,
    signal: new AbortController().signal,
    store: {} as never,
  } as unknown as AttemptContext;
}

const policy = (over: Partial<Parameters<typeof withIsolationPolicy>[1]> = {}) => {
  const audits: unknown[] = [];
  return {
    audits,
    policy: {
      db: {} as never,
      hosted: false,
      audit: async (_s: unknown, e: unknown) => void audits.push(e),
      ...over,
    } as Parameters<typeof withIsolationPolicy>[1],
  };
};

test("isolation classes are ordered container < gvisor < microvm < vm", () => {
  expect(ISOLATION_ORDER).toEqual(["container", "gvisor", "microvm", "vm"]);
  for (const a of ISOLATION_ORDER)
    for (const b of ISOLATION_ORDER) {
      expect(isolationAtLeast(a, b)).toBe(ISOLATION_ORDER.indexOf(a) >= ISOLATION_ORDER.indexOf(b));
    }
});

test("trust comes from the untrusted-author approval or the run plan, and defaults to trusted", () => {
  expect(trustOf({}, null)).toBe("trusted");
  expect(trustOf({ approvalKind: null }, "{}")).toBe("trusted");
  expect(trustOf({ approvalKind: "environment" }, null)).toBe("trusted");
  expect(trustOf({ approvalKind: "untrusted_author" }, null)).toBe("untrusted");
  expect(trustOf({}, '{"trust":"untrusted"}')).toBe("untrusted");
  expect(trustOf({}, '{"trust":"untrusted_pr"}')).toBe("untrusted"); // the trust module's class
  for (const klass of ["protected", "release", "trusted_pr", "trusted"]) {
    expect(trustOf({}, JSON.stringify({ trust: klass }))).toBe("trusted");
  }
  expect(trustOf({}, "not json")).toBe("trusted");
  expect(trustOf({}, '{"trust":"UNTRUSTED"}')).toBe("trusted");
});

test("minimums: untrusted needs gvisor, a hosted instance needs microvm for everything", () => {
  expect(requiredIsolation("trusted", false)).toBe("container");
  expect(requiredIsolation("untrusted", false)).toBe("gvisor");
  expect(requiredIsolation("trusted", true)).toBe("microvm");
  expect(requiredIsolation("untrusted", true)).toBe("microvm");
});

test("a provider that meets the minimum runs the job untouched", async () => {
  let ran = 0;
  const { policy: p } = policy();
  const runner = withIsolationPolicy(async () => (ran++, ok), p);
  expect((await runner(ctx("container"))).state).toBe("success");
  expect((await runner(ctx("gvisor", { approvalKind: "untrusted_author" }))).state).toBe("success");
  expect((await runner(ctx("vm", { plan: '{"trust":"untrusted"}' }))).state).toBe("success");
  expect(ran).toBe(3);
});

test("an untrusted job on a container provider is refused as infra_error, naming both classes", async () => {
  let ran = 0;
  const { policy: p, audits } = policy();
  const runner = withIsolationPolicy(async () => (ran++, ok), p);
  const out = await runner(ctx("container", { approvalKind: "untrusted_author" }));
  expect(out.state).toBe("infra_error");
  expect(out.reason).toBe(
    "isolation: provider testprov is container; untrusted runs need gvisor or stronger",
  );
  expect(ran).toBe(0);
  expect(audits).toHaveLength(0);
});

test("a hosted instance refuses container and gvisor for every run", async () => {
  let ran = 0;
  const { policy: p } = policy({ hosted: true });
  const runner = withIsolationPolicy(async () => (ran++, ok), p);
  for (const cls of ["container", "gvisor"] as const) {
    const out = await runner(ctx(cls));
    expect(out.state).toBe("infra_error");
    expect(out.reason).toContain("hosted instance need microvm or stronger");
  }
  expect((await runner(ctx("microvm"))).state).toBe("success");
  expect((await runner(ctx("vm"))).state).toBe("success");
  expect(ran).toBe(2);
});

test("an explicit override lets it run, is audited with the reason, and shows on the job's log", async () => {
  const box: { seen?: AttemptContext | undefined } = {};
  const seen = (): AttemptContext | undefined => box.seen;
  const { policy: p, audits } = policy({
    override: { reason: "dev box, no untrusted code expected" },
  });
  const runner = withIsolationPolicy(async (c) => ((box.seen = c), ok), p);
  const out = await runner(ctx("container", { approvalKind: "untrusted_author" }));
  expect(out.state).toBe("success");
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    op: "isolation.override",
    principalKind: "system",
    input: {
      runId: "run1",
      jobId: "job1",
      attemptId: "att1",
      provider: "testprov",
      have: "container",
      need: "gvisor",
      trust: "untrusted",
      reason: "dev box, no untrusted code expected",
    },
  });
  expect(seen()?.notices?.[0]).toContain("isolation override");
  expect(seen()?.notices?.[0]).toContain("dev box, no untrusted code expected");
  // an override does not touch jobs that meet the minimum: no audit row, no notice
  audits.length = 0;
  delete box.seen;
  await runner(ctx("container"));
  expect(audits).toHaveLength(0);
  expect(seen()?.notices).toBeUndefined();
});
