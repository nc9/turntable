import { expect, test } from "bun:test";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { ProviderInfo } from "@turntable/provider-sdk";
import { isolationAtLeast, ISOLATION_ORDER } from "@turntable/provider-sdk";
import { requiredIsolation, trustOf, withIsolationPolicy } from "../src/scheduler/isolation";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";

const ok: AttemptOutcome = { state: "success", reason: "ok" };

function ctx(
  isolation: ProviderInfo["isolation"],
  opts: {
    approvalKind?: string | null;
    plan?: string | null;
    trust?: string | null;
    local?: boolean;
  } = {},
): AttemptContext {
  const world = new FakeWorld();
  const provider = world.provider();
  return {
    attempt: { id: "att1" },
    job: { id: "job1", approvalKind: opts.approvalKind ?? null },
    run: {
      id: "run1",
      plan: opts.plan ?? null,
      trust: opts.trust ?? null,
      // A run with no stated class is a local one unless the test says otherwise.
      local: opts.local ?? (opts.plan === undefined && opts.trust === undefined),
      event: "push",
      ref: "refs/heads/main",
    },
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

const run = (over: Record<string, unknown> = {}) => ({
  local: false,
  event: "push",
  ref: "refs/heads/main",
  trust: null as string | null,
  plan: null as string | null,
  ...over,
});
const decided = (klass: string) => JSON.stringify({ class: klass });

test("trust fails closed: only a stored trusted class, or a local run, is trusted", () => {
  // A missing class on a run that is not local is untrusted; so is an unparseable one.
  expect(trustOf({}, run())).toBe("untrusted");
  expect(trustOf({}, run({ plan: "{}" }))).toBe("untrusted");
  expect(trustOf({}, run({ plan: "not json" }))).toBe("untrusted");
  expect(trustOf({}, run({ trust: "not json" }))).toBe("untrusted");
  // An unknown string is untrusted, including near misses and the old bare word.
  for (const bad of ["trusted", "TRUSTED_PR", "weird", "", "untrusted", "untrusted_pr"]) {
    expect(trustOf({}, run({ plan: JSON.stringify({ trust: bad }) }))).toBe("untrusted");
    expect(trustOf({}, run({ trust: decided(bad) }))).toBe("untrusted");
  }
  expect(trustOf({}, run({ trust: JSON.stringify({ notclass: "protected" }) }))).toBe("untrusted");
  // The three trusted classes are trusted, from either copy.
  for (const klass of ["protected", "release", "trusted_pr"]) {
    expect(trustOf({}, run({ trust: decided(klass) }))).toBe("trusted");
    expect(trustOf({}, run({ plan: JSON.stringify({ trust: klass }) }))).toBe("trusted");
    expect(
      trustOf({}, run({ trust: decided(klass), plan: JSON.stringify({ trust: klass }) })),
    ).toBe("trusted");
  }
  // If the two copies disagree, the lower wins.
  expect(
    trustOf(
      {},
      run({ trust: decided("protected"), plan: JSON.stringify({ trust: "untrusted_pr" }) }),
    ),
  ).toBe("untrusted");
  // A local run (the operator's own checkout) is trusted, with or without a class.
  expect(trustOf({}, run({ local: true }))).toBe("trusted");
  // A job that needed untrusted-author approval is untrusted whatever the class.
  expect(trustOf({ approvalKind: "untrusted_author" }, run({ trust: decided("protected") }))).toBe(
    "untrusted",
  );
  expect(trustOf({ approvalKind: "environment" }, run({ trust: decided("protected") }))).toBe(
    "trusted",
  );
});

test("a job the demotion rule lowers is untrusted for isolation too", () => {
  // A privileged trigger handed a non-protected ref.
  expect(
    trustOf(
      {},
      run({ event: "pull_request_target", ref: "refs/pull/5/head", trust: decided("trusted_pr") }),
    ),
  ).toBe("untrusted");
  // A privileged trigger on a protected ref, without a head checkout, is not demoted.
  expect(
    trustOf(
      {},
      run({ event: "workflow_run", ref: "refs/heads/main", trust: decided("protected") }),
    ),
  ).toBe("trusted");
  // A step that checks out the PR head (listed at ingest by job id) demotes that job only.
  const plan = JSON.stringify({ trust: "protected", headCheckouts: ["risky"] });
  const privileged = run({
    event: "workflow_run",
    ref: "refs/heads/main",
    trust: decided("protected"),
    plan,
  });
  expect(trustOf({ jobKey: "risky" }, privileged)).toBe("untrusted");
  expect(trustOf({ jobKey: "safe" }, privileged)).toBe("trusted");
  expect(trustOf({ jobKey: "x", planned: JSON.stringify({ id: "risky" }) }, privileged)).toBe(
    "untrusted",
  );
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
  expect((await runner(ctx("vm", { plan: '{"trust":"untrusted_pr"}' }))).state).toBe("success");
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

test("a non-local run with no class is refused on a container provider (fails closed)", async () => {
  const { policy: p } = policy();
  const runner = withIsolationPolicy(async () => ok, p);
  const out = await runner(ctx("container", { plan: "{}", local: false }));
  expect(out.state).toBe("infra_error");
  expect(out.reason).toContain("untrusted runs need gvisor");
  expect((await runner(ctx("container", { plan: "{}", local: true }))).state).toBe("success");
  expect((await runner(ctx("gvisor", { plan: "{}", local: false }))).state).toBe("success");
});
