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
import { onPostgres } from "./pg-mode";
import { checkReleaseLane } from "../src/doctor/checks";
import type { DoctorInputs } from "../src/doctor/types";
import { dispatch, registry } from "../src/ops";
import { AttestationStore } from "../src/release/attest";
import {
  CHILD_PASSTHROUGH_ENV,
  LaneSupervisor,
  laneSupervised,
  prepareSupervisedLane,
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

describe("roles", () => {
  test("release still refuses to share a process with any other role", () => {
    expect(() => resolveRoles("web,release", {})).toThrow(/runs alone/);
    expect(() => resolveRoles("all,release", {})).toThrow(/runs alone/);
    expect(() => resolveRoles("worker,release", {})).toThrow(/runs alone/);
    expect([...resolveRoles("release", {})]).toEqual(["release"]);
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

  test("a crashed child restarts, requests fail with a named error in the gap, and doctor says so", async () => {
    const f = fakeSpawner();
    let ready = true;
    const sup = new LaneSupervisor({
      prepared: prepared(),
      args: [],
      command: ["x"],
      spawn: f.spawn,
      probe: async () => ready,
      log: () => {},
      backoff: { baseMs: 80, maxMs: 80, stableMs: 1e9 },
      readyPollMs: 10,
    });
    sup.start();
    await until(() => sup.availability().ok);
    expect(f.procs).toHaveLength(1);
    expect(f.procs[0]!.env).toEqual({ A: "1" });

    ready = false; // the restarted child is not up yet
    f.procs[0]!.exit(1);
    await until(() => sup.status().state === "restarting");
    const gap = sup.availability();
    expect(gap).toMatchObject({ ok: false, code: "release_lane_unavailable", state: "restarting" });
    expect(sup.status().lastExit).toMatchObject({ code: 1 });

    const doctor = checkReleaseLane({ releaseLane: () => sup.status() } as unknown as DoctorInputs);
    expect(doctor.status).toBe("fail");
    expect(doctor.summary).toContain("restarting");
    expect(doctor.summary).toContain("release_lane_unavailable");

    await until(() => f.procs.length === 2); // started again after the backoff
    expect(sup.availability()).toMatchObject({ ok: false, state: "starting" });
    ready = true;
    await until(() => sup.availability().ok);
    expect(sup.status().restarts).toBe(1);
    expect(
      checkReleaseLane({ releaseLane: () => sup.status() } as unknown as DoctorInputs).status,
    ).toBe("pass");

    await sup.stop();
    expect(f.procs[1]!.killed).toEqual(["SIGTERM"]);
    expect(sup.status().state).toBe("stopped");
    expect(f.procs).toHaveLength(2); // no restart after stop
  });

  test("a child that keeps failing waits longer each time", async () => {
    const f = fakeSpawner();
    const starts: number[] = [];
    const sup = new LaneSupervisor({
      prepared: prepared(),
      args: [],
      command: ["x"],
      spawn: (a, e) => (starts.push(Date.now()), f.spawn(a, e)),
      probe: async () => false,
      log: () => {},
      backoff: { baseMs: 40, maxMs: 1000, stableMs: 1e9 },
    });
    sup.start();
    for (let i = 0; i < 3; i++) {
      await until(() => f.procs.length === i + 1);
      f.procs[i]!.exit(1);
    }
    await until(() => f.procs.length === 4);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    expect(gaps[1]!).toBeGreaterThanOrEqual(gaps[0]! + 20);
    expect(gaps[2]!).toBeGreaterThanOrEqual(gaps[1]! + 30);
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

  test("doctor: not supervised here passes", () => {
    expect(checkReleaseLane({} as unknown as DoctorInputs).status).toBe("pass");
  });
});

describe("through a real child process (fakes for the forge and the signer)", () => {
  let db: Db;
  let a: Tenant;
  let sup: LaneSupervisor | undefined;
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
    "request_release with dry_run round-trips through the child; a killed child restarts and the gap fails by name",
    { timeout: 90_000 },
    async () => {
      sup = new LaneSupervisor({
        prepared,
        command: [process.execPath, join(import.meta.dir, "fixtures", "lane-child.ts")],
        args: ["--data-dir", dataDir()],
        log: () => {},
        backoff: { baseMs: 700, maxMs: 700, stableMs: 1e9 },
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
      await until(async () => (await getReleaseRequest(db, a.scope, coId))?.status !== "pending");
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

      // kill the child: the gap fails with a named error, then it is back
      process.kill(sup.status().pid!, "SIGKILL");
      await until(() => !sup!.availability().ok);
      const gap = await request(tok);
      expect(gap.ok).toBe(false);
      if (!gap.ok) {
        expect(gap.error.code).toBe("unavailable");
        expect(gap.error.message).toContain("release_lane_unavailable");
      }
      expect(sup.status().lastExit?.signal).toBe("SIGKILL");
      await until(() => sup!.availability().ok);
      expect(sup.status().restarts).toBe(1);
      const again = await request(tok);
      expect(again.ok).toBe(true);
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
