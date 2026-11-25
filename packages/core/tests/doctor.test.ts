import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobCa } from "@turntable/proxy";
import { DIALECT } from "../src/db/dialect";
import { createOrg, openDatabase, setGithubApp, type Db } from "../src/db";
import { dispatch, registry } from "../src/ops";
import { embeddedMigrationTags } from "../src/db/read-only";
import { SECRET_APP_ID, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "../src/github/app-auth";
import { SecretStore } from "../src/secrets/store";
import {
  checkChannel,
  checkConfigChannel,
  checkDatabase,
  checkForwarded,
  checkGithubApp,
  checkHttpsRedirect,
  checkAuditAnchors,
  checkMasterKey,
  checkReleaseKey,
  checkPrivileges,
  checkProxyTls,
  checkQuotas,
  MISSING_DATABASE,
  runDoctor,
} from "../src/doctor/checks";
import { doctorCommand, renderReport } from "../src/doctor/cli";
import { ForwardedObserver } from "../src/doctor/observe";
import {
  channelProbe,
  configChannelProbe,
  readerOf,
  releaseLaneExpected,
} from "../src/doctor/real";
import {
  forApi,
  report,
  type DoctorFs,
  type DoctorInputs,
  type FileFacts,
  type ForwardedSnapshot,
} from "../src/doctor/types";
import { controlPost } from "@turntable/net";
import { cachedDoctor } from "../src/doctor/cache";
import { channelMac, startChannel } from "../src/release/channel";
import { mintToken, seedWorld } from "./ops-helpers";

const DIR = "/srv/turntable";
const KEY = "/run/secrets/master.key";
const NOW = Date.UTC(2026, 10, 23);
const DAY = 86_400_000;
const WEBHOOK = ["whsec", "doctor", "test", "7731"].join("_");

/** A filesystem described as a map from path to facts and bytes. */
function fakeFs(
  files: Record<string, Partial<FileFacts> & { bytes?: Buffer; writable?: boolean }>,
): DoctorFs {
  return {
    stat(p) {
      const f = files[p];
      if (!f) return undefined;
      return {
        uid: f.uid ?? 65532,
        gid: f.gid ?? 65532,
        mode: f.mode ?? 0o600,
        size: f.size ?? f.bytes?.length ?? 0,
        isDirectory: f.isDirectory ?? false,
      };
    },
    writable: (p) => files[p]?.writable ?? true,
    read: (p) => files[p]?.bytes,
    list: (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1)),
  };
}

const goodFiles = (): Record<
  string,
  Partial<FileFacts> & { bytes?: Buffer; writable?: boolean }
> => ({
  [DIR]: { isDirectory: true, mode: 0o750 },
  [KEY]: { size: 32, mode: 0o600 },
});

const onPostgres = DIALECT === "pg";

/** Runs a write against the test database on either dialect (the doctor itself only reads). */
async function edit(q: SQL): Promise<void> {
  const orm = db.orm as unknown as { run?(q: SQL): unknown; execute?(q: SQL): Promise<unknown> };
  await (onPostgres ? orm.execute!(q) : orm.run!(q));
}

let db: Db;
let masterKey: Buffer;
let orgId: string;
let inputs: DoctorInputs;

async function seedApp(): Promise<void> {
  const store = new SecretStore(db, masterKey);
  await setGithubApp(
    db,
    { orgId },
    {
      appId: "42",
      slug: "turntable-test",
      name: "Turntable",
      ownerLogin: "acme",
      htmlUrl: "https://github.com/apps/x",
      clientId: "Iv1.abc",
    },
  );
  await store.set(orgId, SECRET_APP_ID, "42");
  await store.set(
    orgId,
    SECRET_PRIVATE_KEY,
    "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  );
  await store.set(orgId, SECRET_WEBHOOK, WEBHOOK);
}

const base = (over: Partial<DoctorInputs> = {}): DoctorInputs => ({
  env: { TURNTABLE_MASTER_KEY_FILE: KEY, TURNTABLE_TRUST_FORWARDED_PROTO: "1" },
  dataDir: DIR,
  hosted: false,
  fs: fakeFs(goodFiles()),
  proc: { uid: 65532, gid: 65532 },
  db: readerOf(db),
  expectedMigrations: embeddedMigrationTags(),
  masterKey: () => masterKey,
  providerChecks: async () => [
    {
      id: "docker.health",
      area: "provider",
      status: "pass",
      summary: "the docker provider answers its health check",
    },
  ],
  channel: undefined,
  observed: undefined,
  now: () => NOW,
  ...over,
});

beforeEach(async () => {
  db = openDatabase(":memory:");
  masterKey = randomBytes(32);
  orgId = (await createOrg(db, { slug: "acme", name: "Acme" })).id;
  await seedApp();
  inputs = base();
});

const one = <T extends { id: string }>(cs: T[], id: string): T => cs.find((c) => c.id === id)!;

describe("a ready instance", () => {
  test("every check passes, and the report holds no secret", async () => {
    const r = await runDoctor(inputs);
    expect(r.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(r.status).toBe("pass");
    expect(r.counts.fail + r.counts.warn).toBe(0);
    const text = JSON.stringify(r) + renderReport(r);
    expect(text).not.toContain(WEBHOOK);
    expect(text).not.toContain(masterKey.toString("hex"));
    expect(text).not.toContain(masterKey.toString("base64"));
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });

  test("every non-pass finding carries a fix", async () => {
    const r = await runDoctor(
      base({ proc: { uid: 0, gid: 0 }, fs: fakeFs({}), masterKey: () => undefined, env: {} }),
    );
    for (const c of r.checks.filter((x) => x.status !== "pass")) expect(c.fix).toBeTruthy();
    expect(r.status).toBe("fail");
  });

  test("a check that throws is a fail, not a crash", async () => {
    const r = await runDoctor(
      base({
        providerChecks: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(
      r.checks.some((c) => c.status === "fail" && c.summary.includes("check itself failed")),
    ).toBe(true);
  });
});

describe("privileges and the data directory", () => {
  test("root is a fail; root with a drop configured is a warning to run as that user", () => {
    const root = base({ proc: { uid: 0, gid: 0 } });
    expect(one(checkPrivileges(root), "privileges")).toMatchObject({ status: "fail" });
    const dropping = base({
      proc: { uid: 0, gid: 0 },
      env: { TURNTABLE_DROP_PRIVILEGES: "65532:65532" },
    });
    expect(one(checkPrivileges(dropping), "privileges")).toMatchObject({ status: "warn" });
    expect(one(checkPrivileges(inputs), "privileges")).toMatchObject({ status: "pass" });
  });

  test("a missing directory warns; a file, an unwritable or world-writable directory do not pass", () => {
    const at = (f: Record<string, Partial<FileFacts> & { writable?: boolean }>) =>
      one(checkPrivileges(base({ fs: fakeFs(f) })), "data_dir");
    expect(at({})).toMatchObject({ status: "warn" });
    expect(at({ [DIR]: { isDirectory: false } })).toMatchObject({ status: "fail" });
    const locked = at({ [DIR]: { isDirectory: true, uid: 0, writable: false } });
    expect(locked).toMatchObject({ status: "fail" });
    expect(locked.fix).toContain("chown");
    expect(at({ [DIR]: { isDirectory: true, mode: 0o777 } })).toMatchObject({ status: "warn" });
    expect(at({ [DIR]: { isDirectory: true, uid: 1000 } })).toMatchObject({ status: "warn" });
    expect(at(goodFiles())).toMatchObject({ status: "pass" });
  });
});

describe("the release key and the audit anchor", () => {
  test("a release key file inside a data directory warns; outside, it passes; unset, no check", () => {
    expect(checkReleaseKey(base())).toEqual([]);
    const at = (file: string, dataDir?: string) =>
      checkReleaseKey(base({ releaseKey: { file, dataDir } }));
    const inMain = at(`${DIR}/release.key`);
    expect(inMain[0]).toMatchObject({ status: "warn" });
    expect(inMain[0]!.summary).toContain("data directory");
    expect(inMain[0]!.fix).toContain("TURNTABLE_RELEASE_MASTER_KEY");
    expect(at("/release/state/r.key", "/release/state")[0]).toMatchObject({ status: "warn" });
    expect(at("/run/secrets/release.key", "/release/state")[0]).toMatchObject({ status: "pass" });
    expect(JSON.stringify(inMain)).not.toContain("release.key");
  });
  test("an anchor that does not open names the fix: set the previous key and restart", () => {
    expect(checkAuditAnchors(base({ unreadableAnchors: () => [] }))).toMatchObject({
      status: "pass",
    });
    const r = checkAuditAnchors(base({ unreadableAnchors: () => ["01ORGAAAA"] }));
    expect(r).toMatchObject({ status: "fail" });
    expect(r.fix).toContain("audit anchor for org 01ORGAAAA");
    expect(r.fix).toContain("TURNTABLE_MASTER_KEY_PREVIOUS");
    expect(r.fix).toContain("restart");
  });
});

describe("the master key", () => {
  const at = (
    files: Record<string, Partial<FileFacts>>,
    env: Record<string, string | undefined>,
    hosted = false,
  ) => checkMasterKey(base({ fs: fakeFs(files), env, hosted }));

  test("unset warns, and fails when hosted", () => {
    expect(at({}, {})).toMatchObject({ status: "warn" });
    expect(at({}, {}, true)).toMatchObject({ status: "fail" });
  });
  test("missing, wrong size, loose mode and good", () => {
    const env = { TURNTABLE_MASTER_KEY_FILE: KEY };
    expect(at({}, env)).toMatchObject({ status: "fail" });
    expect(at({ [KEY]: { size: 31 } }, env)).toMatchObject({ status: "fail" });
    const loose = at({ [KEY]: { size: 32, mode: 0o644 } }, env);
    expect(loose).toMatchObject({ status: "warn" });
    expect(loose.fix).toContain("chmod 600");
    expect(at({ [KEY]: { size: 32, mode: 0o400 } }, env)).toMatchObject({ status: "pass" });
  });
  test("a key file inside the data directory warns: every volume backup holds it", () => {
    const inData = `${DIR}/master.key`;
    const r = at(
      { [DIR]: { isDirectory: true }, [inData]: { size: 32, mode: 0o600 } },
      { TURNTABLE_MASTER_KEY_FILE: inData },
    );
    expect(r).toMatchObject({ status: "warn" });
    expect(r.summary).toContain("inside the data directory");
    expect(r.fix).toContain("TURNTABLE_MASTER_KEY");
    // A key on a separate mount is fine.
    expect(
      at({ [KEY]: { size: 32, mode: 0o600 } }, { TURNTABLE_MASTER_KEY_FILE: KEY }),
    ).toMatchObject({ status: "pass" });
  });
  test("a key from the environment passes; a key file left in the data directory warns", () => {
    const base_ = (files: Record<string, Partial<FileFacts>>) =>
      checkMasterKey(base({ fs: fakeFs(files), env: {}, masterKeyEnv: true }));
    expect(base_({ [DIR]: { isDirectory: true } })).toMatchObject({ status: "pass" });
    const stray = base_({
      [DIR]: { isDirectory: true },
      [`${DIR}/master.key`]: { size: 32, mode: 0o600 },
    });
    expect(stray).toMatchObject({ status: "warn" });
    expect(stray.summary).toContain("master.key");
    expect(stray.fix).toContain("rotate");
    // Other files of other sizes are not key files.
    expect(
      base_({ [DIR]: { isDirectory: true }, [`${DIR}/turntable.db`]: { size: 4096 } }),
    ).toMatchObject({ status: "pass" });
  });
  test("the variable and a configured file together fail", () => {
    expect(
      checkMasterKey(
        base({ fs: fakeFs({}), env: { TURNTABLE_MASTER_KEY_FILE: KEY }, masterKeyEnv: true }),
      ),
    ).toMatchObject({ status: "fail" });
  });
  test("the key's path is not in the output", () => {
    expect(
      JSON.stringify(at({ [KEY]: { size: 31 } }, { TURNTABLE_MASTER_KEY_FILE: KEY })),
    ).not.toContain(KEY);
  });
});

describe("the database", () => {
  test("up to date: reachable and every migration applied", async () => {
    const cs = await checkDatabase(inputs);
    expect(one(cs, "database").status).toBe("pass");
    expect(one(cs, "migrations").status).toBe("pass");
  });
  test("pending migrations warn, and a database from a newer version fails", async () => {
    const last = embeddedMigrationTags().at(-1)!;
    await edit(sql`DELETE FROM __turntable_migrations WHERE tag = ${last}`);
    expect(one(await checkDatabase(inputs), "migrations")).toMatchObject({ status: "warn" });
    await edit(sql`INSERT INTO __turntable_migrations (tag, applied_at) VALUES (${last}, 1)`);
    await edit(
      sql`INSERT INTO __turntable_migrations (tag, applied_at) VALUES ('9999_from_the_future', 1)`,
    );
    const newer = one(await checkDatabase(inputs), "migrations");
    expect(newer).toMatchObject({ status: "fail" });
    expect(newer.fix).toContain("backup");
  });
  test("no file yet warns; an unopenable one fails", async () => {
    expect(
      (await checkDatabase(base({ db: undefined, openError: MISSING_DATABASE })))[0],
    ).toMatchObject({ status: "warn" });
    expect(
      (await checkDatabase(base({ db: undefined, openError: "database is locked" })))[0],
    ).toMatchObject({ status: "fail" });
  });
});

describe("the GitHub App", () => {
  test("credentials present and opening pass", async () => {
    expect(await checkGithubApp(inputs)).toMatchObject({ status: "pass" });
  });
  test("no App warns, and fails when hosted", async () => {
    await edit(sql`DELETE FROM github_apps`);
    expect(await checkGithubApp(inputs)).toMatchObject({ status: "warn" });
    expect(await checkGithubApp(base({ hosted: true }))).toMatchObject({ status: "fail" });
  });
  test("a missing webhook secret fails and names which", async () => {
    await edit(sql`DELETE FROM secrets WHERE name = ${SECRET_WEBHOOK}`);
    const c = await checkGithubApp(inputs);
    expect(c).toMatchObject({ status: "fail" });
    expect(c.summary).toContain("webhook secret missing");
  });
  test("a different master key cannot open the records: unreadable, and no value shown", async () => {
    const c = await checkGithubApp(base({ masterKey: () => randomBytes(32) }));
    expect(c).toMatchObject({ status: "fail" });
    expect(c.summary).toContain("unreadable");
    expect(c.summary).not.toContain(WEBHOOK);
    expect(await checkGithubApp(base({ masterKey: () => undefined }))).toMatchObject({
      status: "fail",
    });
  });
});

describe("provider checks", () => {
  test("a provider's findings are included as they are", async () => {
    const r = await runDoctor(
      base({
        providerChecks: async () => [
          { id: "daytona.api", area: "provider", status: "pass", summary: "ok" },
          {
            id: "daytona.snapshot",
            area: "provider",
            status: "fail",
            summary: "snapshot x does not exist",
            fix: "create it",
          },
        ],
      }),
    );
    expect(one(r.checks, "daytona.snapshot")).toMatchObject({ status: "fail", fix: "create it" });
    expect(r.status).toBe("fail");
  });
});

describe("the proxy's TLS certificate", () => {
  const cert = (nowMs: number, ttlMs: number, host = "proxy.example.test") => {
    const leaf = new JobCa({ label: "doctor", now: nowMs, ttlMs }).leafFor(host);
    return leaf;
  };
  const withCert = (c: { key: string; cert: string }, extra: Record<string, string> = {}) =>
    base({
      env: { TURNTABLE_PROXY_TLS_CERT_FILE: "/c", TURNTABLE_PROXY_TLS_KEY_FILE: "/k", ...extra },
      fs: fakeFs({ "/c": { bytes: Buffer.from(c.cert) }, "/k": { bytes: Buffer.from(c.key) } }),
    });

  test("not configured passes; only one of the two files fails", () => {
    expect(checkProxyTls(inputs)).toMatchObject({ status: "pass" });
    expect(checkProxyTls(base({ env: { TURNTABLE_PROXY_TLS_CERT_FILE: "/c" } }))).toMatchObject({
      status: "fail",
    });
  });
  test("a good certificate passes and says how long it has", () => {
    const c = checkProxyTls(
      withCert(cert(NOW, 90 * DAY), { TURNTABLE_PROXY_ADVERTISE_HOST: "proxy.example.test" }),
    );
    expect(c.status).toBe("pass");
    expect(c.summary).toMatch(/valid for \d+ more days/);
  });
  test("expiring soon warns, expired and not yet valid fail", () => {
    expect(checkProxyTls(withCert(cert(NOW, 5 * DAY)))).toMatchObject({ status: "warn" });
    expect(checkProxyTls(withCert(cert(NOW - 40 * DAY, 10 * DAY)))).toMatchObject({
      status: "fail",
    });
    expect(checkProxyTls(withCert(cert(NOW + 30 * DAY, 30 * DAY)))).toMatchObject({
      status: "fail",
    });
  });
  test("a key from another certificate fails; a certificate for another host warns", () => {
    const a = cert(NOW, 90 * DAY);
    const other = new JobCa({ label: "other", now: NOW, ttlMs: 90 * DAY }).leafFor("other.test");
    expect(checkProxyTls(withCert({ cert: a.cert, key: other.key }))).toMatchObject({
      status: "fail",
    });
    expect(
      checkProxyTls(withCert(a, { TURNTABLE_PROXY_ADVERTISE_HOST: "elsewhere.example.test" })),
    ).toMatchObject({ status: "warn" });
  });
  test("unreadable or garbage files fail without echoing them", () => {
    const g = base({
      env: { TURNTABLE_PROXY_TLS_CERT_FILE: "/c", TURNTABLE_PROXY_TLS_KEY_FILE: "/k" },
      fs: fakeFs({
        "/c": { bytes: Buffer.from("not a cert") },
        "/k": { bytes: Buffer.from("not a key") },
      }),
    });
    const c = checkProxyTls(g);
    expect(c.status).toBe("fail");
    expect(c.summary).not.toContain("not a cert");
    expect(
      checkProxyTls(
        base({
          env: { TURNTABLE_PROXY_TLS_CERT_FILE: "/c", TURNTABLE_PROXY_TLS_KEY_FILE: "/k" },
          fs: fakeFs({}),
        }),
      ),
    ).toMatchObject({ status: "fail" });
  });
});

describe("forwarded headers against the settings", () => {
  const seen = (o: Partial<ForwardedSnapshot>): ForwardedSnapshot => ({
    requests: 10,
    withForwardedProto: 0,
    withForwardedFor: 0,
    ...o,
  });
  const at = (observed: ForwardedSnapshot | undefined, env: Record<string, string>) =>
    checkForwarded(base({ env, observed }));

  test("from the command line it only states the settings", () => {
    expect(at(undefined, {})).toMatchObject({ status: "pass" });
  });
  test("no traffic yet cannot be compared", () => {
    expect(at(seen({ requests: 0 }), {}).summary).toContain("no requests");
  });
  test("a proxy sends X-Forwarded-Proto but it is not trusted: a warning", () => {
    const c = at(seen({ withForwardedProto: 10 }), {});
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("TURNTABLE_TRUST_FORWARDED_PROTO");
  });
  test("X-Forwarded-For with no trusted proxies: a warning", () => {
    const c = at(seen({ withForwardedFor: 3 }), { TURNTABLE_TRUST_FORWARDED_PROTO: "1" });
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("TURNTABLE_TRUSTED_PROXIES");
  });
  test("trust is set but no header ever arrives: a warning", () => {
    expect(at(seen({}), { TURNTABLE_TRUST_FORWARDED_PROTO: "1" }).status).toBe("warn");
    expect(at(seen({}), { TURNTABLE_TRUSTED_PROXIES: "10.0.0.0/8" }).status).toBe("warn");
  });
  test("settings and traffic that agree pass", () => {
    expect(
      at(seen({ withForwardedProto: 10, withForwardedFor: 10 }), {
        TURNTABLE_TRUST_FORWARDED_PROTO: "1",
        LONGSHORT: "x",
        TURNTABLE_TRUSTED_PROXIES: "10.0.0.0/8",
      }).status,
    ).toBe("pass");
    expect(at(seen({}), {}).status).toBe("pass");
  });
  test("the observer counts what requests carry", () => {
    const o = new ForwardedObserver();
    o.record(new Request("http://x/", { headers: { "x-forwarded-proto": "https" } }));
    o.record(
      new Request("http://x/", {
        headers: { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "http" },
      }),
    );
    o.record(new Request("http://x/"));
    expect(o.snapshot()).toEqual({ requests: 3, withForwardedProto: 2, withForwardedFor: 1 });
  });
});

describe("the https redirect", () => {
  test("behind a trusted proxy it passes", () => {
    expect(
      checkHttpsRedirect(base({ env: { TURNTABLE_TRUST_FORWARDED_PROTO: "1" } })),
    ).toMatchObject({ status: "pass" });
  });
  test("with no trusted proxy it warns, and fails when hosted", () => {
    expect(checkHttpsRedirect(base({ env: {} }))).toMatchObject({ status: "warn" });
    const hosted = checkHttpsRedirect(base({ env: {}, hosted: true }));
    expect(hosted).toMatchObject({ status: "fail" });
    expect(hosted.fix).toContain("Always Use HTTPS");
  });
  test("HSTS turned off warns", () => {
    expect(
      checkHttpsRedirect(
        base({ env: { TURNTABLE_TRUST_FORWARDED_PROTO: "1", TURNTABLE_HSTS_MAX_AGE: "off" } }),
      ),
    ).toMatchObject({ status: "warn" });
  });
});

describe("quotas", () => {
  test("a build without the table says so", async () => {
    const noTable = { all: async () => [], hasTable: async () => false };
    expect(await checkQuotas(base({ db: noTable }))).toMatchObject({ status: "pass" });
  });
  test("none set warns when hosted, set passes", async () => {
    expect(await checkQuotas(inputs)).toMatchObject({ status: "pass" });
    expect(await checkQuotas(base({ hosted: true }))).toMatchObject({ status: "warn" });
    await edit(
      sql`INSERT INTO org_quotas (org_id, max_concurrent, updated_by, updated_at) VALUES (${orgId}, 4, 'test', 0)`,
    );
    expect(await checkQuotas(base({ hosted: true }))).toMatchObject({ status: "pass" });
  });
});

describe("the release lane config channel", () => {
  const MSG = "release lane config channel unreachable: release approvals will be refused";
  const probe = (ok: boolean) => async () =>
    ok ? ({ ok: true } as const) : ({ ok: false, reason: "not reachable" } as const);

  test("no release lane configured at all: passes", async () => {
    const r = await checkConfigChannel(base({ releaseLaneExpected: false }));
    expect(r).toMatchObject({ status: "pass" });
    expect(r.summary).not.toContain("unreachable");
  });
  test("a lane is expected and the config channel answers: passes", async () => {
    const r = await checkConfigChannel(
      base({ releaseLaneExpected: true, configChannel: probe(true) }),
    );
    expect(r).toMatchObject({ status: "pass" });
  });
  test("a lane is expected and the config channel cannot be reached: fails with the exact message", async () => {
    const down = await checkConfigChannel(
      base({ releaseLaneExpected: true, configChannel: probe(false) }),
    );
    expect(down).toMatchObject({ status: "fail", summary: MSG });
    // no config key on this process at all: the same refusal, and the fix names the setting
    const unset = await checkConfigChannel(base({ releaseLaneExpected: true }));
    expect(unset).toMatchObject({ status: "fail", summary: MSG });
    expect(JSON.stringify(unset)).toContain("TURNTABLE_PUBLISH_CONFIG_KEY_FILE");
  });
  test("what real doctor inputs expect: any lane variable, and a probe only with a config key", () => {
    expect(releaseLaneExpected({})).toBe(false);
    expect(releaseLaneExpected({ TURNTABLE_PUBLISH_CHANNEL_SOCKET: "/s" })).toBe(true);
    expect(configChannelProbe({ TURNTABLE_PUBLISH_CHANNEL_SOCKET: "/s" })).toBeUndefined();
  });
});

describe("the release channel", () => {
  test("not configured passes", async () => {
    expect(await checkChannel(inputs)).toMatchObject({ status: "pass" });
  });
  test("a missing or loose key file, then the probe's answer", async () => {
    const env = { TURNTABLE_PUBLISH_CHANNEL_KEY_FILE: "/ck" };
    const probe = (ok: boolean) => async () =>
      ok ? ({ ok: true } as const) : ({ ok: false, reason: "not reachable" } as const);
    expect(await checkChannel(base({ env, channel: probe(true), fs: fakeFs({}) }))).toMatchObject({
      status: "fail",
    });
    expect(
      await checkChannel(
        base({ env, channel: probe(true), fs: fakeFs({ "/ck": { mode: 0o644 } }) }),
      ),
    ).toMatchObject({ status: "warn" });
    expect(
      await checkChannel(base({ env, channel: probe(true), fs: fakeFs({ "/ck": {} }) })),
    ).toMatchObject({ status: "pass" });
    const down = await checkChannel(
      base({ env, channel: probe(false), fs: fakeFs({ "/ck": {} }) }),
    );
    expect(down).toMatchObject({ status: "fail" });
    expect(down.summary).toContain("not reachable");
  });

  describe("against a real lane channel", () => {
    let dir: string;
    let stop: (() => void) | undefined;
    const key = "k".repeat(32);
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ls-doctor-"));
    });
    afterEach(() => {
      stop?.();
      stop = undefined;
      rmSync(dir, { recursive: true, force: true });
    });
    const keyFile = (k: string): string => {
      const p = join(dir, "channel.key");
      writeFileSync(p, k, { mode: 0o600 });
      return p;
    };

    test("the right key reaches the lane; the wrong key is rejected; no lane is unreachable", async () => {
      const socket = join(dir, "run", "channel.sock");
      const ch = await startChannel({
        db,
        proxy: {
          release() {},
          register: async () => ({ ok: false, reason: "not_approved" }),
        } as never,
        key,
        listen: { unix: socket },
      });
      stop = () => ch.stop();
      const env = (file: string, sock = socket) => ({
        TURNTABLE_PUBLISH_CHANNEL_KEY_FILE: file,
        TURNTABLE_PUBLISH_CHANNEL_SOCKET: sock,
      });
      expect(await channelProbe(env(keyFile(key)))!()).toEqual({ ok: true });
      const wrong = await channelProbe(env(keyFile("w".repeat(32))))!();
      expect(wrong).toMatchObject({ ok: false });
      expect((wrong as { reason: string }).reason).toContain("rejected the request key");
      const gone = await channelProbe(env(keyFile(key), join(dir, "nothing.sock")))!();
      expect((gone as { reason: string }).reason).toContain("not reachable");
      expect(channelProbe({})).toBeUndefined();
    });

    test("the probe is the health call: it changes nothing and a bad mac is refused", async () => {
      const socket = join(dir, "run", "channel.sock");
      const released: string[] = [];
      let registers = 0;
      const ch = await startChannel({
        db,
        proxy: {
          release: (id: string) => released.push(id),
          register: async () => {
            registers += 1;
            return { ok: false, reason: "not_approved" };
          },
        } as never,
        key,
        listen: { unix: socket },
      });
      stop = () => ch.stop();
      const env = {
        TURNTABLE_PUBLISH_CHANNEL_KEY_FILE: keyFile(key),
        TURNTABLE_PUBLISH_CHANNEL_SOCKET: socket,
      };
      expect(await channelProbe(env)!()).toEqual({ ok: true });
      expect(released).toEqual([]);
      expect(registers).toBe(0);
      const ts = Date.now();
      const post = (path: string, body: object) =>
        controlPost({ unix: socket }, path, body, { timeoutMs: 5000 });
      expect(
        (await post("/v1/health", { ts, mac: channelMac(key, "health", [], ts) })).status,
      ).toBe(200);
      expect(
        (await post("/v1/health", { ts, mac: channelMac("x".repeat(32), "health", [], ts) }))
          .status,
      ).toBe(401);
      // A health MAC is not a revoke MAC: it cannot be replayed against a state-changing op.
      const cross = await post("/v1/revoke", {
        attemptId: "a1",
        ts,
        mac: channelMac(key, "health", [], ts),
      });
      expect(cross.status).toBe(401);
      expect(released).toEqual([]);
    });
  });
});

describe("the operation and the command", () => {
  test("the doctor operation is for the instance operator only: an in-process owner", async () => {
    const { db: wdb, a, b } = await seedWorld();
    const owner = (orgId: string) => ({
      kind: "principal" as const,
      principal: { kind: "member" as const, id: "cli", orgId, role: "owner" as const },
    });
    const run = (
      cred: Parameters<typeof dispatch>[1],
      doctor?: () => Promise<Awaited<ReturnType<typeof runDoctor>>>,
    ) => dispatch({ registry, db: wdb, ...(doctor ? { doctor } : {}) }, cred, "doctor", {});
    // A canned report: on Postgres under test, seedWorld's fresh open empties the shared `db`.
    const canned = report([{ id: "x", area: "keys", status: "pass", summary: "fine" }]);
    const ok = await run(owner(a.scope.orgId), async () => canned);
    expect(ok.ok && (ok.output as { status: string }).status).toBe("pass");
    const unwired = await run(owner(a.scope.orgId));
    expect(unwired.ok && (unwired.output as { status: string }).status).toBe("warn");
    // No token of any role reaches it, in any org; neither does a member below owner.
    for (const role of ["reader", "operator", "release_operator"] as const) {
      for (const w of [a, b]) {
        const token = (await mintToken(wdb, w.scope, role)).secret;
        const r = await run({ kind: "bearer", token }, () => runDoctor(inputs));
        expect(r.ok).toBe(false);
      }
    }
    const admin = await run(
      {
        kind: "principal",
        principal: { kind: "member", id: "m", orgId: a.scope.orgId, role: "admin" },
      },
      () => runDoctor(inputs),
    );
    expect(admin.ok).toBe(false);
    expect(registry.get("doctor")!.auth).toEqual({ type: "token", minRole: "owner" });
    // Not offered to agents: neither MCP nor the OpenAPI document lists it.
    expect(registry.mcpOps().map((o) => o.name)).not.toContain("doctor");
    expect(registry.documentedOps().map((o) => o.name)).not.toContain("doctor");
  });

  test("the API output has fixed sentences only; the CLI keeps the detail", async () => {
    const leak = "ECONNREFUSED 10.1.2.3:5432 secret-host.internal";
    const r = await runDoctor(
      base({
        providerChecks: async () => [
          {
            id: "daytona.api",
            area: "provider",
            status: "fail",
            summary: "not usable",
            detail: leak,
          },
        ],
        db: {
          all: async () => {
            throw new Error(leak);
          },
          hasTable: async () => {
            throw new Error(leak);
          },
        },
      }),
    );
    expect(renderReport(r)).toContain(leak);
    const { db: wdb, a } = await seedWorld();
    const out = await dispatch(
      { registry, db: wdb, doctor: async () => r },
      {
        kind: "principal",
        principal: { kind: "member", id: "cli", orgId: a.scope.orgId, role: "owner" },
      },
      "doctor",
      {},
    );
    expect(out.ok).toBe(true);
    const text = JSON.stringify(out.ok ? out.output : {});
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("secret-host");
    expect(text).not.toContain("detail");
    expect(forApi(r).checks.some((c) => c.status === "fail")).toBe(true);
  });

  test("runs triggered through the server are cached for 30 seconds and shared", async () => {
    let calls = 0;
    let clock = 1_000;
    const slow = cachedDoctor(
      async () => {
        calls += 1;
        await Bun.sleep(5);
        return runDoctor(inputs);
      },
      30_000,
      () => clock,
    );
    await Promise.all([slow(), slow(), slow()]);
    expect(calls).toBe(1);
    clock += 29_000;
    await slow();
    expect(calls).toBe(1);
    clock += 2_000;
    await slow();
    expect(calls).toBe(2);
  });

  // SQLite only: it relies on a data directory with no database file in it. A Postgres process is
  // pointed at a server by URL, not by a file in the data directory.
  test.skipIf(onPostgres)(
    "the command prints a report, changes nothing, and exits 1 on a failure",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ls-doctor-cli-"));
      try {
        const lines: string[] = [];
        const log = console.log;
        console.log = (m: string) => void lines.push(String(m));
        let code: number;
        try {
          code = await doctorCommand(
            [
              "--data-dir",
              join(dir, "data"),
              "--json",
              "--provider",
              "daytona",
              "--provider-config",
              join(dir, "nope.json"),
            ],
            { TURNTABLE_MASTER_KEY_FILE: join(dir, "absent.key") },
          );
        } finally {
          console.log = log;
        }
        const r = JSON.parse(lines.join("\n")) as {
          status: string;
          checks: { id: string; status: string }[];
        };
        expect(r.status).toBe("fail");
        expect(code).toBe(1);
        expect(r.checks.find((c) => c.id === "master_key")?.status).toBe("fail");
        expect(r.checks.find((c) => c.id === "database")?.status).toBe("warn");
        expect(r.checks.some((c) => c.id.endsWith(".config") && c.status === "fail")).toBe(true);
        // nothing was created: no database, no data directory
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("the report reads as lines with fixes under each problem", () => {
    const text = renderReport({
      status: "fail",
      counts: { pass: 1, warn: 0, fail: 1 },
      checks: [
        { id: "a", area: "keys", status: "pass", summary: "fine" },
        { id: "b", area: "database", status: "fail", summary: "broken", fix: "mend it" },
      ],
    });
    expect(text).toContain("PASS  keys: fine");
    expect(text).toContain("FAIL  database: broken\n      fix: mend it");
    expect(text).toContain("1 passed, 0 warning(s), 1 failed");
  });
});
