import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getReleaseRequest, openDatabase, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { loadSettingsRuntime } from "../src/settings/boot";
import { approvalPolicySetting, settingsRegistry } from "../src/settings/definitions";
import { withoutRefusals } from "../src/settings/define";
import { operatorSizes, parseSandboxSizes, setOperatorSizes } from "../src/scheduler/sandbox-size";
import { envValue } from "../src/settings/resolve";
import { onPostgres } from "./pg-mode";
import { checkChannel, checkConfigChannel, checkReleaseLane } from "../src/doctor/checks";
import type { DoctorInputs } from "../src/doctor/types";
import { dispatch, registry } from "../src/ops";
import { AttestationStore } from "../src/release/attest";
import {
  CHILD_PASSTHROUGH_ENV,
  LaneSupervisor,
  laneSupervised,
  prepareSupervisedLane,
  removeStaleLaneDirs,
  selfCommand,
  spawnLane,
  type LaneProcess,
  type LaneSpawner,
} from "../src/release/supervisor";
import { cosignKeyId } from "../src/release/cosign";
import { ReleaseProxy } from "../src/release/proxy";
import { SecretVault } from "../src/secrets/vault";
import { releaseEnvPresent, resolveRoles } from "../src/roles";
import { mintToken, seedTenant, type Tenant } from "./ops-helpers";

const SHA = "a".repeat(40);
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tt-lane-sup-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
}

/** A parent's environment with the release lane configured and secrets that are not the lane's. */
function parentEnv(): Record<string, string | undefined> {
  return {
    PATH: "/usr/bin",
    TZ: "UTC",
    HOME: "/home/someone",
    TURNTABLE_MASTER_KEY: randomBytes(32).toString("hex"),
    TURNTABLE_GITHUB_TOKEN: "main-token",
    TURNTABLE_DATABASE_URL: "main-db",
    TURNTABLE_LANE_SUPERVISED: "1",
    TURNTABLE_RELEASE_MASTER_KEY: randomBytes(32).toString("hex"),
    TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS: randomBytes(32).toString("hex"),
    TURNTABLE_RELEASE_DATA_DIR: join(tmp, "rel"),
    TURNTABLE_RELEASE_GITHUB_TOKEN: "lane-forge-token",
    TURNTABLE_RELEASE_GITHUB_PUBLISH_TOKEN: "lane-publish-token",
    TURNTABLE_RELEASE_ARTIFACT_DIR: join(tmp, "art"),
    TURNTABLE_RELEASE_BUILDER_ID: "https://ci.example.com",
    LONGSHORE_RELEASE_SOMETHING: "old-spelling", // rename-keep: the pre-rename prefix
  };
}

describe("the parent holds no release variable after it prepares the lane", () => {
  test("every release variable leaves process.env, and only the child's environment has them", () => {
    const env = parentEnv();
    expect(releaseEnvPresent(env).length).toBe(8);
    const p = prepareSupervisedLane({ env, runDir: tmp });
    try {
      expect(releaseEnvPresent(env)).toEqual([]);
      // the parent keeps what is its own
      expect(env.TURNTABLE_MASTER_KEY).toBeDefined();
      expect(env.TURNTABLE_GITHUB_TOKEN).toBe("main-token");
      expect(Object.values(env)).not.toContain("lane-forge-token");
      expect(Object.values(env)).not.toContain("lane-publish-token");
      expect(p.childEnv.TURNTABLE_RELEASE_GITHUB_TOKEN).toBe("lane-forge-token");
    } finally {
      p.cleanup();
    }
  });

  test("a bad lane configuration stops the boot, and the variables are gone from the environment anyway", () => {
    const env = parentEnv();
    delete env.TURNTABLE_RELEASE_BUILDER_ID;
    expect(() => prepareSupervisedLane({ env, runDir: tmp })).toThrow(/BUILDER_ID/);
    expect(releaseEnvPresent(env)).toEqual([]);
  });

  test("the operator may not set what the supervisor makes, and Postgres needs the lane's own URL", () => {
    expect(() =>
      prepareSupervisedLane({
        env: { ...parentEnv(), TURNTABLE_PUBLISH_CHANNEL_KEY_FILE: "/k" },
        runDir: tmp,
      }),
    ).toThrow(/unset TURNTABLE_PUBLISH_CHANNEL_KEY_FILE/);
    expect(() =>
      prepareSupervisedLane({
        env: { ...parentEnv(), TURNTABLE_RELEASE_CHANNEL_SOCKET: "/x.sock" },
        runDir: tmp,
      }),
    ).toThrow(/supervisor makes the channel/);
    expect(() => prepareSupervisedLane({ env: parentEnv(), postgres: true, runDir: tmp })).toThrow(
      /TURNTABLE_RELEASE_DATABASE_URL/,
    );
    const env = { ...parentEnv(), TURNTABLE_RELEASE_DATABASE_URL: "postgres://lane@db/x" };
    const p = prepareSupervisedLane({ env, postgres: true, runDir: tmp });
    // the lane's own URL, never the main one
    expect(p.childEnv.TURNTABLE_DATABASE_URL).toBe("postgres://lane@db/x");
    expect(Object.values(p.childEnv)).not.toContain("main-db");
    p.cleanup();
  });

  test("the socket lives in a 0700 directory, and the keys are made per boot", () => {
    const a = prepareSupervisedLane({ env: parentEnv(), runDir: tmp });
    const b = prepareSupervisedLane({ env: parentEnv(), runDir: tmp });
    try {
      const dir = join(a.socket, "..");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(a.childEnv.TURNTABLE_RELEASE_CHANNEL_KEY).not.toBe(
        b.childEnv.TURNTABLE_RELEASE_CHANNEL_KEY,
      );
      expect(a.childEnv.TURNTABLE_RELEASE_CHANNEL_KEY).not.toBe(
        a.childEnv.TURNTABLE_RELEASE_CHANNEL_CONFIG_KEY,
      );
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

describe("the child's environment is exactly the allowlist", () => {
  test("allowlisted names, the release variables and the supervisor's own, and nothing else", () => {
    const env = parentEnv();
    const p = prepareSupervisedLane({ env, runDir: tmp });
    try {
      expect(Object.keys(p.childEnv).toSorted()).toEqual(
        [
          "PATH",
          "TZ",
          "LONGSHORE_RELEASE_SOMETHING", // rename-keep
          "TURNTABLE_LANE_CHILD",
          "TURNTABLE_RELEASE_ARTIFACT_DIR",
          "TURNTABLE_RELEASE_BUILDER_ID",
          "TURNTABLE_RELEASE_CHANNEL_CONFIG_KEY",
          "TURNTABLE_RELEASE_CHANNEL_KEY",
          "TURNTABLE_RELEASE_CHANNEL_SOCKET",
          "TURNTABLE_RELEASE_DATA_DIR",
          "TURNTABLE_RELEASE_GITHUB_PUBLISH_TOKEN",
          "TURNTABLE_RELEASE_GITHUB_TOKEN",
          "TURNTABLE_RELEASE_MASTER_KEY",
          "TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS",
          "TURNTABLE_RELEASE_PROXY_PORT",
        ].toSorted(),
      );
      for (const k of [
        "TURNTABLE_MASTER_KEY",
        "TURNTABLE_GITHUB_TOKEN",
        "TURNTABLE_DATABASE_URL",
        "HOME",
      ])
        expect(p.childEnv[k]).toBeUndefined();
      expect(CHILD_PASSTHROUGH_ENV).toContain("PATH");
    } finally {
      p.cleanup();
    }
  });

  test("a real child process sees those names and no others", async () => {
    const env = parentEnv();
    const p = prepareSupervisedLane({ env, runDir: tmp });
    try {
      const out = join(tmp, "seen.json");
      const proc = spawnLane(
        [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(Object.keys(process.env)))",
          out,
        ],
        { ...p.childEnv },
      );
      await proc.exited;
      const seen = JSON.parse(readFileSync(out, "utf8")) as string[];
      expect(seen.toSorted()).toEqual(Object.keys(p.childEnv).toSorted());
    } finally {
      p.cleanup();
    }
  });
});

describe("the operator's approval policy reaches the child", () => {
  test("TURNTABLE_APPROVAL_POLICY and the config path are passed, no other setting is", () => {
    const policy = JSON.stringify({ release: { required: 3, key_policy: "hardware" } });
    const env = {
      ...parentEnv(),
      TURNTABLE_APPROVAL_POLICY: policy,
      TURNTABLE_CONFIG: "/etc/turntable.toml",
      TURNTABLE_GLOBAL_CAP: "9",
    };
    const p = prepareSupervisedLane({ env, runDir: tmp });
    try {
      expect(p.childEnv.TURNTABLE_APPROVAL_POLICY).toBe(policy);
      expect(p.childEnv.TURNTABLE_CONFIG).toBe("/etc/turntable.toml");
      expect(p.childEnv.TURNTABLE_GLOBAL_CAP).toBeUndefined();
    } finally {
      p.cleanup();
    }
    const q = prepareSupervisedLane({ env: parentEnv(), config: "/x/c.toml", runDir: tmp });
    try {
      expect(q.childEnv.TURNTABLE_CONFIG).toBe("/x/c.toml");
      expect(q.childEnv.TURNTABLE_APPROVAL_POLICY).toBeUndefined();
    } finally {
      q.cleanup();
    }
  });

  test("a child that loads those inputs resolves the operator's policy, not the default", () => {
    const policy = { release: { required: 3, key_policy: "hardware" } };
    const toml = join(tmp, "t.toml");
    writeFileSync(toml, "[orgs.acme.approval_policy.release]\nrequired = 2\n");
    const p = prepareSupervisedLane({
      env: { ...parentEnv(), TURNTABLE_APPROVAL_POLICY: JSON.stringify(policy) },
      config: toml,
      runDir: tmp,
    });
    try {
      const rt = loadSettingsRuntime({ env: p.childEnv, config: p.childEnv.TURNTABLE_CONFIG });
      expect(JSON.stringify(envValue(approvalPolicySetting, rt.env)?.value)).toContain(
        '"required":3',
      );
      expect(rt.toml.orgs.get("acme")?.has("approval_policy")).toBe(true);
    } finally {
      p.cleanup();
    }
  });
});

describe("roles", () => {
  test("release still refuses to share a process with any other role", () => {
    expect(() => resolveRoles("web,release", {})).toThrow(/runs alone/);
    expect(() => resolveRoles("all,release", {})).toThrow(/runs alone/);
    expect(() => resolveRoles("worker,release", {})).toThrow(/runs alone/);
    expect([...resolveRoles("release", {})]).toEqual(["release"]);
  });

  test("a turntable.toml with org runner_labels onto an operator size class boots the parent and the lane child", () => {
    const toml = join(tmp, "turntable.toml");
    writeFileSync(toml, `[orgs.x]\nrunner_labels = { big = "large" }\n`);
    const prior = operatorSizes();
    try {
      // The parent has the operator's size map: the labels are checked against it and boot.
      setOperatorSizes(
        parseSandboxSizes(
          JSON.stringify({ classes: { large: { cpus: 4, tenantSelectable: true } } }),
          "test",
        ),
      );
      expect(() => loadSettingsRuntime({ config: toml, env: {} })).not.toThrow();
      // The child is never given the size map (its environment is minimal): the full registry
      // would refuse the label, the lane's registry does not judge it.
      setOperatorSizes(undefined);
      expect(() => loadSettingsRuntime({ config: toml, env: {} })).toThrow(/large/);
      const rt = loadSettingsRuntime({
        config: toml,
        env: {},
        registry: withoutRefusals(settingsRegistry),
      });
      // It still resolves what the lane uses.
      expect(rt.registry.get(approvalPolicySetting.key)).toBeDefined();
    } finally {
      setOperatorSizes(prior);
    }
  });

  test("the supervised lane is off unless asked for", () => {
    expect(laneSupervised({})).toBe(false);
    expect(laneSupervised({ TURNTABLE_LANE_SUPERVISED: "0" })).toBe(false);
    expect(laneSupervised({ TURNTABLE_LANE_SUPERVISED: "1" })).toBe(true);
  });
});

/** A fake child: the test decides when it is ready and when it exits. */
function fakeSpawner() {
  const procs: {
    env: Record<string, string>;
    exit(code: number | null, signal?: string): void;
    killed: string[];
  }[] = [];
  const spawn: LaneSpawner = (_argv, env) => {
    let done!: (v: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (done = r));
    const rec = {
      env,
      killed: [] as string[],
      exit: (code: number | null, signal = "") => done({ code, signal: signal || null }),
    };
    procs.push(rec);
    const proc: LaneProcess = {
      pid: 1000 + procs.length,
      exited,
      kill: (sig) => {
        rec.killed.push(sig);
        rec.exit(null, sig);
      },
    };
    return proc;
  };
  return { procs, spawn };
}

describe("supervision (fake child)", () => {
  const prepared = () => ({
    childEnv: { A: "1" },
    socket: "/nowhere",
    probeKey: "k",
    cleanup: () => {},
  });

  test("a crashed child is not respawned: the server is told, requests fail by name, and doctor says so", async () => {
    const f = fakeSpawner();
    const lost: string[] = [];
    const sup = new LaneSupervisor({
      prepared: prepared(),
      args: [],
      command: ["x"],
      spawn: f.spawn,
      probe: async () => true,
      onLaneLost: (why) => lost.push(why),
      log: () => {},
      readyPollMs: 10,
    });
    sup.start();
    await until(() => sup.availability().ok);
    expect(f.procs).toHaveLength(1);
    expect(f.procs[0]!.env).toEqual({ A: "1" });

    f.procs[0]!.exit(1);
    await until(() => sup.status().state === "exited");
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("code 1");
    expect(sup.availability()).toMatchObject({
      ok: false,
      code: "release_lane_unavailable",
      state: "exited",
    });
    expect(sup.status().lastExit).toMatchObject({ code: 1 });

    const doctor = checkReleaseLane({ releaseLane: () => sup.status() } as unknown as DoctorInputs);
    expect(doctor.status).toBe("fail");
    expect(doctor.summary).toContain("exited");
    expect(doctor.summary).toContain("release_lane_unavailable");

    await sleep(100);
    expect(f.procs).toHaveLength(1); // never started again
    await sup.stop();
    expect(sup.status().state).toBe("stopped");
    expect(lost).toHaveLength(1);
  });

  test("the supervisor keeps none of the child's variables once it has spawned", async () => {
    const f = fakeSpawner();
    const p = prepared();
    const sup = new LaneSupervisor({
      prepared: p,
      args: [],
      command: ["x"],
      spawn: f.spawn,
      probe: async () => true,
      log: () => {},
      readyPollMs: 10,
    });
    sup.start();
    await until(() => sup.availability().ok);
    expect(f.procs[0]!.env).toEqual({ A: "1" });
    expect(Object.keys(p.childEnv)).toEqual([]);
    await sup.stop();
  });

  test("stop escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    let sigs: string[] = [];
    let done!: (v: { code: number | null; signal: string | null }) => void;
    const sup = new LaneSupervisor({
      prepared: prepared(),
      args: [],
      command: ["x"],
      spawn: () => ({
        pid: 1,
        exited: new Promise((r) => (done = r)),
        kill: (sig) => {
          sigs.push(sig);
          if (sig === "SIGKILL") done({ code: null, signal: "SIGKILL" });
        },
      }),
      probe: async () => true,
      log: () => {},
      stopGraceMs: 50,
    });
    sup.start();
    await until(() => sup.availability().ok);
    await sup.stop();
    expect(sigs).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a spawn that throws ends the lane (exited), tells the server once, and never throws out", async () => {
    const lost: string[] = [];
    const sup = new LaneSupervisor({
      prepared: prepared(),
      args: [],
      command: ["x"],
      spawn: () => {
        throw new Error("ENOENT: no such binary");
      },
      probe: async () => true,
      onLaneLost: (w) => lost.push(w),
      log: () => {},
    });
    sup.start();
    await until(() => sup.status().state === "exited");
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("could not be started");
    expect(sup.availability()).toMatchObject({ ok: false, code: "release_lane_unavailable" });
    await sup.stop();
    expect(sup.status().state).toBe("stopped");
  });

  test("an asked-for stop is not a lost lane", async () => {
    const f = fakeSpawner();
    const lost: string[] = [];
    const sup = new LaneSupervisor({
      prepared: prepared(),
      args: [],
      command: ["x"],
      spawn: f.spawn,
      probe: async () => true,
      onLaneLost: (w) => lost.push(w),
      log: () => {},
      readyPollMs: 10,
    });
    sup.start();
    await until(() => sup.availability().ok);
    await sup.stop();
    expect(lost).toEqual([]);
  });

  test("stop is not delayed by a readiness poll that is waiting", async () => {
    const f = fakeSpawner();
    const sup = new LaneSupervisor({
      prepared: prepared(),
      args: [],
      command: ["x"],
      spawn: f.spawn,
      probe: async () => false, // never ready: the poll keeps sleeping
      log: () => {},
      readyPollMs: 60_000,
    });
    sup.start();
    await until(() => f.procs.length === 1);
    await sleep(50);
    const t = Date.now();
    const stopping = sup.stop();
    f.procs[0]!.exit(0); // the child honours SIGTERM
    await stopping;
    expect(Date.now() - t).toBeLessThan(2000);
  });

  test("a ready child that stops answering is 'unresponsive' (not 'starting'), then killed and the server told", async () => {
    const f = fakeSpawner();
    let answering = true;
    const lost: string[] = [];
    const sup = new LaneSupervisor({
      prepared: prepared(),
      args: [],
      command: ["x"],
      spawn: f.spawn,
      probe: async () => answering,
      onLaneLost: (w) => lost.push(w),
      log: () => {},
      readyPollMs: 10,
      healthPollMs: 10,
      healthMisses: 3,
    });
    sup.start();
    await until(() => sup.status().state === "ready");
    answering = false;
    await until(() => sup.status().state === "unresponsive");
    expect(sup.availability()).toMatchObject({ ok: false, state: "unresponsive" });
    await until(() => f.procs[0]!.killed.includes("SIGKILL"));
    await until(() => lost.length === 1);
    expect(f.procs).toHaveLength(1);
    await sup.stop();
  });

  test("selfCommand does not pass a bunfs path; stale socket directories of dead owners are removed", () => {
    expect(selfCommand().some((a) => a.startsWith("/$bunfs/"))).toBe(false);
    const dead = join(tmp, "tt-lane-dead");
    const live = join(tmp, "tt-lane-live");
    const foreign = join(tmp, "tt-lane-nopid");
    for (const d of [dead, live, foreign]) mkdirSync(d);
    writeFileSync(join(dead, "owner.pid"), "2147483646");
    writeFileSync(join(live, "owner.pid"), String(process.pid));
    removeStaleLaneDirs(tmp);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    removeStaleLaneDirs(join(tmp, "absent")); // never throws
  });

  test("doctor: the channel checks name the supervised lane instead of saying nothing is configured", async () => {
    const i = { releaseLane: () => ({}), env: {} } as unknown as DoctorInputs;
    for (const r of [await checkChannel(i), await checkConfigChannel(i)]) {
      expect(r.status).toBe("pass");
      expect(r.summary).toContain("supervised child");
    }
  });

  test("doctor: not supervised here passes", () => {
    expect(checkReleaseLane({} as unknown as DoctorInputs).status).toBe("pass");
  });
});

describe("through a real child process (fakes for the forge and the signer)", () => {
  let db: Db;
  let a: Tenant;
  let sup: LaneSupervisor | undefined;
  const lostWhy: string[] = [];
  let cosigB64 = "";
  let prepared: ReturnType<typeof prepareSupervisedLane>;
  const dataDir = () => join(tmp, "data");

  beforeEach(async () => {
    mkdirSync(dataDir(), { recursive: true });
    db = openDatabase(join(dataDir(), "turntable.db"));
    a = await seedTenant(db, "org-a");
    await db.orm
      .update(s.runs)
      .set({ repo: "acme/web", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
      .where(eq(s.runs.id, a.runId));
    // the lane's own state: the pinned repository
    mkdirSync(join(tmp, "rel"), { recursive: true });
    const attest = new AttestationStore(join(tmp, "rel", "attested.db"));
    attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
    // a co-signing key pinned in the lane's own file; the client holds the private half
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    attest.setCosignKey(
      a.orgId,
      a.projectId,
      {
        name: "pinned",
        public_key_pem: pem,
        signs: "manifest.json",
        output_name: "manifest.json.sig",
        format: "detached-der-p256-sha256",
      },
      0,
    );
    attest.close();
    mkdirSync(join(tmp, "art", a.runId), { recursive: true });
    writeFileSync(join(tmp, "art", a.runId, "cli-linux"), "binary-bytes");
    const manifest = JSON.stringify({
      signing_key_id: cosignKeyId(pem),
      sha256: createHash("sha256").update("binary-bytes").digest("hex"),
    });
    writeFileSync(join(tmp, "art", a.runId, "manifest.json"), manifest);
    cosigB64 = sign("sha256", Buffer.from(manifest), {
      key: pair.privateKey,
      dsaEncoding: "der",
    }).toString("base64");
    prepared = prepareSupervisedLane({ env: parentEnv(), runDir: tmp });
  });
  afterEach(async () => {
    await sup?.stop();
    sup = undefined;
    db.close();
  });

  const request = async (tok: string, dry = true) =>
    dispatch(
      { registry, db, releaseLane: sup! },
      { kind: "bearer", token: tok },
      "request_release",
      {
        run_id: a.runId,
        tag: "v1.0.0",
        artifacts: ["cli-linux"],
        dry_run: dry,
      },
    );

  // the child opens its own SQLite file; on Postgres it would need the lane's own database URL
  test.skipIf(onPostgres)(
    "request_release with dry_run round-trips through the child; a killed child is not respawned and the gap fails by name",
    { timeout: 90_000 },
    async () => {
      sup = new LaneSupervisor({
        prepared,
        command: [process.execPath, join(import.meta.dir, "fixtures", "lane-child.ts")],
        args: ["--data-dir", dataDir()],
        log: () => {},
        onLaneLost: (w) => lostWhy.push(w),
        readyPollMs: 50,
      });
      sup.start();
      await until(() => sup!.availability().ok);

      // the child was started with exactly the supervisor's environment (names, before it read any)
      const names = JSON.parse(readFileSync(join(tmp, "child-env.json"), "utf8")) as string[];
      const want = Object.keys(prepared.childEnv);
      for (const k of want) expect(names).toContain(k);
      for (const k of [
        "HOME",
        "TURNTABLE_MASTER_KEY",
        "TURNTABLE_GITHUB_TOKEN",
        "TURNTABLE_DATABASE_URL",
      ])
        expect(names).not.toContain(k);

      const tok = (await mintToken(db, a.scope, "release_operator")).secret;
      const made = await request(tok);
      if (!made.ok) throw new Error(`${made.error.code} ${made.error.message}`);
      const id = (made.output as { id: string }).id;
      // the child's lane claims it from the database and checks it with its own forge and bytes
      await until(async () => {
        const r = await getReleaseRequest(db, a.scope, id);
        return r?.status === "signed" || r?.status === "refused" || r?.status === "error";
      });
      const row = (await getReleaseRequest(db, a.scope, id))!;
      expect(row).toMatchObject({ status: "signed", dryRun: true });
      const got = await dispatch(
        { registry, db },
        { kind: "bearer", token: tok },
        "get_release_request",
        { id },
      );
      expect(got.ok && (got.output as { status: string }).status).toBe("verified");

      // a co-signed request goes the same way: the lane alone verifies the signature, under the key
      // pinned in its own file, over the bytes it read itself
      const co = await dispatch(
        { registry, db, releaseLane: sup },
        { kind: "bearer", token: tok },
        "request_release",
        {
          run_id: a.runId,
          tag: "v1.0.0",
          artifacts: ["cli-linux", "manifest.json"],
          dry_run: true,
          cosignatures: [{ key: "pinned", file: "manifest.json", signature_b64: cosigB64 }],
        },
      );
      if (!co.ok) throw new Error(`${co.error.code} ${co.error.message}`);
      const coId = (co.output as { id: string }).id;
      await until(async () => {
        const st = (await getReleaseRequest(db, a.scope, coId))?.status;
        return st === "signed" || st === "refused" || st === "error";
      });
      const coGot = await dispatch(
        { registry, db },
        { kind: "bearer", token: tok },
        "get_release_request",
        { id: coId },
      );
      expect(coGot.ok && (coGot.output as { status: string }).status).toBe("verified");
      expect(
        coGot.ok && (coGot.output as { cosignatures: { status: string }[] }).cosignatures,
      ).toMatchObject([{ key: "pinned", file: "manifest.json", status: "verified" }]);

      // kill the child: the gap fails with a named error, and it is not respawned
      process.kill(sup.status().pid!, "SIGKILL");
      await until(() => !sup!.availability().ok);
      const gap = await request(tok);
      expect(gap.ok).toBe(false);
      if (!gap.ok) {
        expect(gap.error.code).toBe("unavailable");
        expect(gap.error.message).toContain("release_lane_unavailable");
      }
      expect(sup.status().lastExit?.signal).toBe("SIGKILL");
      expect(lostWhy).toHaveLength(1);
      await sleep(300);
      expect(sup.status().state).toBe("exited");
      await until(async () => {
        const rows = await db.orm.select().from(s.releaseRequests);
        return rows.every((r) => r.status !== "pending" && r.status !== "claimed");
      });
      // stopping the parent's supervisor stops the child and removes the socket directory
      const dir = join(prepared.socket, "..");
      await sup.stop();
      expect(existsSync(dir)).toBe(false);
    },
  );
});

describe("the loopback release proxy", () => {
  test("a request without a registered credential is refused, plain or tunnelled, even from loopback", async () => {
    const db = openDatabase(":memory:");
    const attest = new AttestationStore(":memory:");
    let upstreamCalls = 0;
    const proxy = await ReleaseProxy.start({
      db,
      vault: new SecretVault({ db, masterKey: randomBytes(32), lane: "release" }),
      attest,
      bytes: { read: async () => undefined },
      forge: { tagCommit: async () => ({ found: false }) },
      githubToken: async () => undefined,
      bindHost: "127.0.0.1",
      port: 0,
      upstream: async () => {
        upstreamCalls++;
        return new Response("{}", { status: 201 });
      },
      tunnel: async () => {
        upstreamCalls++;
        throw new Error("no tunnel");
      },
    });
    try {
      expect(proxy.host).toBe("127.0.0.1");
      expect(proxy.port).toBeGreaterThan(0);
      // a plain proxied request with no credential, and one with a made-up credential
      for (const headers of [
        {},
        { "proxy-authorization": `Basic ${Buffer.from("attempt:guess").toString("base64")}` },
      ]) {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
          headers: { host: "registry.npmjs.org", ...headers },
        });
        expect(res.status).toBe(407);
      }
      // a CONNECT with no credential gets the same refusal and no tunnel
      const reply = await new Promise<string>((resolve, reject) => {
        const sock = connect(proxy.port, "127.0.0.1", () =>
          sock.write(
            "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n",
          ),
        );
        let buf = "";
        sock.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("\r\n")) {
            sock.destroy();
            resolve(buf);
          }
        });
        sock.on("error", reject);
        sock.on("close", () => resolve(buf));
      });
      expect(reply.split("\r\n")[0]).toContain("407");
      expect(upstreamCalls).toBe(0);
    } finally {
      await proxy.stop();
      attest.close();
      db.close();
    }
  });
});

describe("the compiled binary", () => {
  // The compiled entry is /$bunfs/root/<name>; the child must be started as the binary alone.
  test.skipIf(onPostgres)(
    "with the lane on, the supervised child reaches ready (no restart loop)",
    { timeout: 170_000 },
    async () => {
      const out = join(tmp, "turntable-bin");
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "../src/main.ts")],
        compile: { outfile: out },
      });
      if (!built.success) throw new Error(built.logs.join("\n"));
      const env = parentEnv();
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(env))
        if (v !== undefined && k !== "HOME" && !k.startsWith("LONGSHORE_")) clean[k] = v;
      const p = Bun.spawn(
        [out, "serve", "--roles", "web", "--port", "0", "--data-dir", join(tmp, "data")],
        {
          env: {
            ...clean,
            PATH: process.env.PATH ?? "/usr/bin",
            HOME: tmp,
            TURNTABLE_ALLOW_ROOT: "1",
            TURNTABLE_DATABASE_URL: "",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      let text = "";
      const pump = async (r: ReadableStream<Uint8Array>) => {
        for await (const c of r) text += new TextDecoder().decode(c);
      };
      void pump(p.stdout);
      void pump(p.stderr);
      try {
        await until(
          () =>
            text.includes("[turntable release] release lane started") ||
            p.exitCode !== null ||
            text.includes("unknown command"),
          120_000,
        );
        console.log(text);
        expect(text).not.toContain("unknown command");
        expect(text).toContain("[turntable release] release channel listening");
        expect(text).toContain("[turntable release] release lane started");
        expect(text.match(/release lane exited/g)).toBeNull();
        expect(p.exitCode).toBeNull();
      } finally {
        p.kill("SIGTERM");
        await p.exited;
      }
    },
  );
});
