// A Docker-capable size class (#497): a job with `services:` or `container:` runs in act's
// container mode on the operator's `dockerClass`, every other job stays in host mode, and every
// refusal names its reason. Against the provider double; no Docker is involved.
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, staticResolver, tarDirectory } from "@turntable/act-runner";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { Provider, SandboxResources } from "@turntable/provider-sdk";
import {
  type Db,
  ensureLocalTenant,
  listAttempts,
  listJobs,
  listRuns,
  openDatabase,
  readLog,
  type Scope,
} from "../src/db";
import * as s from "../src/db/schema";
import { GithubClient, pollConfigSchema, pollRepo, type PollRepoConfig } from "../src/poll";
import { createActRunner, Scheduler } from "../src/scheduler";
import { DEFAULT_DOCKER_JOB_IMAGE } from "../src/scheduler/act-runner";
import {
  dockerRefusal,
  parseSandboxSizes,
  refuseLabelMap,
  sandboxSizesSchema,
  sizeFor,
} from "../src/scheduler/sandbox-size";
import { makeGithub } from "./github-stub";

setDefaultTimeout(30_000);

const tmp = mkdtempSync(join(tmpdir(), "tt-docker-class-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 }, dockerInSandbox: true });
const plainWorld = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  plainWorld.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A stand-in for act that records its argv per job. */
const FAKE_ACT = String.raw`#!/bin/sh
J=""; W=""; ARGS="$*"
while [ $# -gt 0 ]; do
  case "$1" in -j) J=$2; shift;; -W) W=$2; shift;; esac
  shift
done
R=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/seen"
printf '%s\n' "$ARGS" > "$R/seen/$J.argv"
printf '{"jobID":"%s","level":"info","msg":"Run","step":"Set up job","stepid":["--setup-job"],"time":"t"}\n' "$J"
printf '{"jobID":"%s","level":"info","msg":"ok","step":"Set up job","stepid":["--setup-job"],"time":"t","stepResult":"success"}\n' "$J"
printf '{"jobID":"%s","jobResult":"success","msg":"ok","time":"t"}\n' "$J"
`;

/** A `docker` in the double's PATH: behaviour from a control file, `up`, `down` or `noimage`. */
function installDocker(w: FakeWorld, control: string): void {
  const bin = join(w.root, "bin", "docker");
  writeFileSync(
    bin,
    `#!/bin/sh
m=$(cat "${control}")
case "$1" in
  info) [ "$m" = down ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }; exit 0 ;;
  image) [ "$m" = noimage ] && exit 1; exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);
}
const control = join(tmp, "docker-mode");
installDocker(world, control);
const setDocker = (mode: "up" | "down" | "noimage"): void => writeFileSync(control, mode);

const CFG = (): PollRepoConfig =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        prBaseline: false,
        authors: ["octocat"],
      },
    ],
  }).repos[0] as PollRepoConfig;

let db: Db;
let scope: Required<Scope>;
let root: string;
beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  root = join(mkdtempSync(join(tmp, "root-")), "tt");
  setDocker("up");
});

const WORKFLOW = `name: svc
on:
  push:
    branches: [main]
jobs:
  db:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
    steps:
      - run: echo db
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: echo plain
`;

const sizes = (extra: Record<string, unknown> = {}) =>
  parseSandboxSizes(
    JSON.stringify({
      classes: {
        small: { cpus: 2, memoryMb: 4096 },
        dind: {
          cpus: 4,
          memoryMb: 8192,
          docker: true,
          providers: { fake: { snapshot: "snap-docker" } },
        },
      },
      default: "small",
      dockerClass: "dind",
      ...extra,
    }),
    "test",
  );

async function runAll(
  opts: {
    sizes?: ReturnType<typeof sizes> | undefined;
    w?: FakeWorld;
    untrusted?: boolean;
  } = {},
) {
  const w = opts.w ?? world;
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  await pollRepo(
    {
      db,
      github: new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com" }),
      provider: "fake",
    },
    CFG(),
  );
  const [r0] = await listRuns(db, scope);
  if (opts.untrusted) {
    const trust = JSON.parse(r0!.trust!);
    await db.run(async (h) => {
      await h.orm
        .update(s.runs)
        .set({
          trust: JSON.stringify({ ...trust, class: "untrusted_pr" }),
          approval: JSON.stringify({ head_sha: r0!.sha, workflow_hash: trust.workflowHash }),
        })
        .where(eq(s.runs.id, r0!.id));
    });
  }
  const real = w.provider();
  const specs: { job: string; spec: Parameters<Provider["create"]>[0] }[] = [];
  const provider: Provider = Object.assign(Object.create(real) as Provider, {
    // A snapshot-style provider: the class's `snapshot` is what the sandbox starts from.
    realiseClass: (
      cls: SandboxResources,
      specific?: Readonly<Record<string, string | number | boolean>>,
    ) => ({
      ok: true as const,
      resources: cls,
      ...(typeof specific?.snapshot === "string" ? { snapshot: specific.snapshot } : {}),
    }),
    create: (spec: Parameters<Provider["create"]>[0]) => {
      specs.push({ job: spec.labels["turntable.job"] as string, spec });
      return real.create(spec);
    },
  });
  const act = await (async () => {
    const d = mkdtempSync(join(tmp, "a-"));
    writeFileSync(join(d, "act"), FAKE_ACT, { mode: 0o755 });
    const bytes = await tarDirectory(d, ["act"]);
    return { bytes, sha256: sha256Hex(bytes) };
  })();
  const repo = await (async () => {
    const d = mkdtempSync(join(tmp, "r-"));
    writeFileSync(join(d, "README.md"), "hi\n");
    return tarDirectory(d, ["README.md"]);
  })();
  const sched = new Scheduler({
    db,
    providers: () => provider,
    runner: createActRunner({
      db,
      source: {
        checkout: async () => ({
          tarball: repo,
          readFile: (p: string) => (p === ".github/workflows/ci.yml" ? WORKFLOW : undefined),
        }),
      },
      resolver: staticResolver({}),
      act,
      planRoot: root,
      pollMs: 30,
      dockerWaitSeconds: 0,
      ...("sizes" in opts ? (opts.sizes ? { sizes: opts.sizes } : {}) : { sizes: sizes() }),
    }),
    globalCap: 1,
    perOrgCap: 1,
    leaseMs: 60_000,
    pollMs: 20,
  });
  for (let i = 0; i < 40; i++) {
    const started = await sched.tick();
    await sched.idle();
    if (started === 0) break;
  }
  const jobs = await listJobs(db, scope, r0!.id);
  const job = (k: string) => jobs.find((j) => j.jobKey === k)!;
  const logOf = async (k: string) => {
    const attempts = await listAttempts(db, scope, job(k).id);
    return Buffer.concat(
      (await readLog(db, scope, attempts.at(-1)!.id)).map((c) => c.bytes),
    ).toString();
  };
  const specOf = (k: string) => specs.find((x) => x.job === job(k).id)?.spec;
  const attemptsOf = async (k: string) => (await listAttempts(db, scope, job(k).id)).length;
  const lastAttempt = async (k: string) => (await listAttempts(db, scope, job(k).id)).at(-1)!;
  const argv = (k: string): string => readFileSync(join(root, "seen", `${k}.argv`), "utf8");
  return { job, logOf, specOf, attemptsOf, lastAttempt, argv };
}

describe("a job that needs Docker", () => {
  test("services: routes to the docker class and act gets container mode; a plain job stays host mode", async () => {
    const r = await runAll();
    expect(r.job("db").state).toBe("success");
    expect(r.job("plain").state).toBe("success");
    // the docker job's sandbox: the docker class's snapshot and size
    expect(r.specOf("db")?.snapshot).toBe("snap-docker");
    expect(r.specOf("db")?.resources).toEqual({ cpus: 4, memoryMb: 8192 });
    // the plain job: the default class
    expect(r.specOf("plain")?.snapshot).toBeUndefined();
    expect(r.specOf("plain")?.resources).toEqual({ cpus: 2, memoryMb: 4096 });
    // act: container mode for one, host mode for the other
    const dbArgv = r.argv("db");
    expect(dbArgv).toContain(`-P ubuntu-latest=${DEFAULT_DOCKER_JOB_IMAGE}`);
    expect(dbArgv).not.toContain("-self-hosted");
    expect(dbArgv).toContain("--container-daemon-socket -");
    expect(dbArgv).not.toContain("docker.sock");
    const plain = r.argv("plain");
    expect(plain).toContain("-P ubuntu-latest=-self-hosted");
    expect(plain).not.toContain(DEFAULT_DOCKER_JOB_IMAGE);
  });

  test("dockerJobImage chooses the image act runs the job in", async () => {
    const r = await runAll({ sizes: sizes({ dockerJobImage: "registry.example/runner:1" }) });
    expect(r.argv("db")).toContain("-P ubuntu-latest=registry.example/runner:1");
  });

  test("no docker class configured: the job fails with the reason and gets no sandbox; the plain job runs", async () => {
    const r = await runAll({
      sizes: parseSandboxSizes(
        JSON.stringify({ classes: { small: { cpus: 2 } }, default: "small" }),
        "t",
      ),
    });
    expect(r.job("db").state).toBe("failure");
    expect(r.specOf("db")).toBeUndefined();
    const log = await r.logOf("db");
    expect(log).toContain("unsupported: uses services:");
    expect(log).toContain("no Docker-capable size class");
    expect(r.job("plain").state).toBe("success");
  });

  test("no size config at all: the same refusal", async () => {
    const r = await runAll({ sizes: undefined });
    expect(r.job("db").state).toBe("failure");
    expect(await r.logOf("db")).toContain("no Docker-capable size class");
  });

  test("a provider that cannot run Docker refuses it, even with a docker class", async () => {
    const r = await runAll({ w: plainWorld });
    expect(r.job("db").state).toBe("failure");
    expect(r.specOf("db")).toBeUndefined();
    expect(await r.logOf("db")).toContain("cannot run Docker inside a sandbox");
  });

  test("an untrusted run's docker job fails unless untrustedDocker is set", async () => {
    const denied = await runAll({ untrusted: true });
    expect(denied.job("db").state).toBe("failure");
    expect(denied.specOf("db")).toBeUndefined();
    expect(await denied.logOf("db")).toContain("untrustedDocker");
    // the untrusted plain job is unaffected
    expect(denied.job("plain").state).toBe("success");
  });

  test("with untrustedDocker the untrusted job uses the docker class", async () => {
    const r = await runAll({ untrusted: true, sizes: sizes({ untrustedDocker: true }) });
    expect(r.job("db").state).toBe("success");
    expect(r.specOf("db")?.snapshot).toBe("snap-docker");
  });

  test("docker info failing in the sandbox is an infra failure, classified infra, with the reason", async () => {
    setDocker("down");
    const r = await runAll();
    expect(r.job("db").state).toBe("infra_error");
    expect(await r.attemptsOf("db")).toBe(1); // the scheduler retries only drain and cancel cuts
    expect((await r.lastAttempt("db")).errorClass).toContain("no working Docker daemon");
    // the plain job never needed the daemon
    expect(r.job("plain").state).toBe("success");
  });

  test("egress none and an image not in the sandbox: fails naming the image, egress is not widened", async () => {
    setDocker("noimage");
    const r = await runAll();
    expect(r.job("db").state).toBe("failure");
    expect(await r.attemptsOf("db")).toBe(1);
    expect(r.specOf("db")?.network).toEqual({ egress: "none" });
    expect(() => r.argv("db")).toThrow(); // act never started
    expect((await r.lastAttempt("db")).errorClass ?? "").toBe("");
  });
});

describe("class config", () => {
  const parse = (classes: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    sandboxSizesSchema.safeParse({ classes, ...extra });

  test("a docker class without a provider image or snapshot is rejected", () => {
    expect(parse({ d: { docker: true } }).success).toBe(false);
    expect(parse({ d: { docker: true, providers: {} } }).success).toBe(false);
    expect(parse({ d: { docker: true, providers: { daytona: {} } } }).success).toBe(false);
    expect(parse({ d: { docker: true, providers: { docker: { cpus: 2 } } } }).success).toBe(false);
    // every provider it names needs its own
    expect(
      parse({
        d: { docker: true, providers: { daytona: { snapshot: "s" }, docker: {} } },
      }).success,
    ).toBe(false);
    expect(parse({ d: { docker: true, providers: { daytona: { snapshot: "s" } } } }).success).toBe(
      true,
    );
    // the deprecated alias counts
    expect(parse({ d: { docker: true, snapshot: "s" } }).success).toBe(true);
  });

  test("a docker class defaults to not tenant selectable; the operator can override", () => {
    const c = parse({
      d: { docker: true, providers: { daytona: { snapshot: "s" } } },
      e: { docker: true, tenantSelectable: true, providers: { daytona: { snapshot: "s" } } },
      f: { cpus: 1 },
    });
    expect(c.success && c.data.classes.d?.tenantSelectable).toBe(false);
    expect(c.success && c.data.classes.e?.tenantSelectable).toBe(true);
    expect(c.success && c.data.classes.f?.tenantSelectable).toBe(true);
  });

  test("dockerClass must name a class with docker: true", () => {
    expect(parse({ a: { cpus: 1 } }, { dockerClass: "a" }).success).toBe(false);
    expect(parse({ a: { cpus: 1 } }, { dockerClass: "nope" }).success).toBe(false);
  });

  test("untrustedDocker defaults to false", () => {
    expect(sizes().untrustedDocker).toBe(false);
  });

  test("a tenant label map cannot name a docker class unless it is selectable or the org is allowlisted (#510)", () => {
    const cfg = (extra: Record<string, unknown>) =>
      parseSandboxSizes(
        JSON.stringify({
          classes: {
            dind: { docker: true, providers: { daytona: { snapshot: "s" } }, ...extra },
          },
        }),
        "t",
      );
    expect(refuseLabelMap({ l: "dind" }, { orgSlug: "acme" }, cfg({}))).toContain(
      "not available to this org",
    );
    expect(refuseLabelMap({ l: "dind" }, { orgSlug: "acme" }, cfg({ orgs: ["acme"] }))).toBe(
      undefined,
    );
    expect(
      refuseLabelMap({ l: "dind" }, { orgSlug: "acme" }, cfg({ tenantSelectable: true })),
    ).toBe(undefined);
  });

  test("sizeFor gives a docker job the docker class whatever its label maps to; others are unaffected", () => {
    const c = sizes({ labels: { big: "small" } });
    expect(sizeFor(c, ["big"], { docker: true }).class).toBe("dind");
    expect(sizeFor(c, ["big"]).class).toBe("small");
  });

  test("dockerRefusal: all three reasons, and none when allowed", () => {
    const ok = { dockerInSandbox: true };
    expect(dockerRefusal(sizes(), "uses services:", { untrusted: false, provider: ok })).toBe(
      undefined,
    );
    expect(
      dockerRefusal(undefined, "uses services:", { untrusted: false, provider: ok }),
    ).toContain("no Docker-capable size class");
    expect(dockerRefusal(sizes(), "uses services:", { untrusted: false, provider: {} })).toContain(
      "cannot run Docker",
    );
    expect(dockerRefusal(sizes(), "uses container:", { untrusted: true, provider: ok })).toContain(
      "untrustedDocker",
    );
  });
});
