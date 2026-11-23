import { createPrivateKey, X509Certificate } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { ingestStatus, POLL_RESERVE } from "../poll/status";
import { open, secretAad } from "../secrets/crypto";
import { RELEASE_KEY_ENV, RELEASE_KEY_PREVIOUS_ENV } from "../roles";
import { anchorKeyMessage } from "../secrets/master-key";
import { SECRET_APP_ID, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "../github/app-auth";
import { type DoctorCheck, type DoctorInputs, report, type DoctorReport } from "./types";

/** `openError` value for a data directory with no database file yet. */
export const MISSING_DATABASE = "missing";
const DAY = 86_400_000;
const CERT_WARN_DAYS = 14;

const pass = (id: string, area: string, summary: string): DoctorCheck => ({
  id,
  area,
  status: "pass",
  summary,
});
const warn = (id: string, area: string, summary: string, fix: string): DoctorCheck => ({
  id,
  area,
  status: "warn",
  summary,
  fix,
});
const fail = (
  id: string,
  area: string,
  summary: string,
  fix: string,
  detail?: string,
): DoctorCheck => ({
  id,
  area,
  status: "fail",
  summary,
  ...(detail ? { detail } : {}),
  fix,
});

const set = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);

/** The process and the data directory: root is dropped, and the directory is ours to write. */
export function checkPrivileges(i: DoctorInputs): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  if (i.proc.uid === 0 && set(i.env.TURNTABLE_DROP_PRIVILEGES)) {
    out.push(
      warn(
        "privileges",
        "process",
        `this check runs as root; the server drops to ${set(i.env.TURNTABLE_DROP_PRIVILEGES)} at start`,
        "Run doctor as that user (or through the API of the running server) for the true picture.",
      ),
    );
  } else if (i.proc.uid === 0) {
    out.push(
      fail(
        "privileges",
        "process",
        "running as root: privileges were not dropped",
        "Set TURNTABLE_DROP_PRIVILEGES=<uid>:<gid> (the image sets 65532:65532 and drops after taking ownership of the data directory), or start the process as a non-root user.",
      ),
    );
  } else {
    out.push(pass("privileges", "process", `running as uid ${i.proc.uid}, not root`));
  }
  const dir = i.fs.stat(i.dataDir);
  if (!dir) {
    out.push(
      warn(
        "data_dir",
        "process",
        "the data directory does not exist yet",
        "It is created at first start. Mount a persistent volume there first, or the data will not survive a restart.",
      ),
    );
  } else if (!dir.isDirectory) {
    out.push(
      fail(
        "data_dir",
        "process",
        "the data path is not a directory",
        "Point --data-dir at a directory.",
      ),
    );
  } else if (!i.fs.writable(i.dataDir)) {
    out.push(
      fail(
        "data_dir",
        "process",
        `the data directory is owned by uid ${dir.uid} and this process (uid ${i.proc.uid}) cannot write to it`,
        `Make it writable by this user, for example: chown -R ${i.proc.uid}:${i.proc.gid} <data dir>. In the image, start as root with TURNTABLE_DROP_PRIVILEGES set and it does this itself.`,
      ),
    );
  } else if ((dir.mode & 0o002) !== 0) {
    out.push(
      warn(
        "data_dir",
        "process",
        "the data directory is writable by everyone",
        "Remove world write: chmod o-w <data dir>. It holds the database and may hold keys.",
      ),
    );
  } else if (dir.uid !== i.proc.uid) {
    out.push(
      warn(
        "data_dir",
        "process",
        `the data directory is owned by uid ${dir.uid}, not this process (uid ${i.proc.uid}), but is writable`,
        `Own it as the service user: chown -R ${i.proc.uid}:${i.proc.gid} <data dir>.`,
      ),
    );
  } else {
    out.push(
      pass(
        "data_dir",
        "process",
        "the data directory exists and is owned and writable by this user",
      ),
    );
  }
  return out;
}

/** True when `path` is `dir` or inside it. */
const inside = (dir: string, path: string): boolean => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const KEY_ON_VOLUME_FIX =
  "Move the key off the volume: set it as TURNTABLE_MASTER_KEY (or mount the file from a separate secrets store), re-wrap with TURNTABLE_MASTER_KEY_PREVIOUS, then delete the file. See the key rotation runbook in docs/hosted.mdx.";

/** The release key file must not sit in a directory that is backed up: the lane's own, or the main one. */
export function checkReleaseKey(i: DoctorInputs): DoctorCheck[] {
  const k = i.releaseKey;
  if (!k) return [];
  const where = [
    inside(i.dataDir, k.file) ? "the data directory" : undefined,
    k.dataDir && inside(k.dataDir, k.file) ? "the release data directory" : undefined,
  ].filter((x): x is string => x !== undefined);
  if (where.length === 0) {
    return [
      pass("release_key", "keys", "the release master key file is outside the data directories"),
    ];
  }
  return [
    warn(
      "release_key",
      "keys",
      `the release master key file is inside ${where.join(" and ")}: every volume backup holds the signing keys' wrapper next to what it unseals`,
      `Set ${RELEASE_KEY_ENV} instead (re-wrap with ${RELEASE_KEY_PREVIOUS_ENV}), then delete the file. See docs/hosted.mdx.`,
    ),
  ];
}

export function checkAuditAnchors(i: DoctorInputs): DoctorCheck {
  const bad = i.unreadableAnchors?.() ?? [];
  if (bad.length === 0) {
    return pass(
      "audit_anchor",
      "keys",
      "the audit anchor state opens under the current master key",
    );
  }
  return fail(
    "audit_anchor",
    "keys",
    `audit anchor for org ${bad.join(", ")} is sealed under another master key (most likely the previous one)`,
    anchorKeyMessage(bad[0]!),
  );
}

/** The sealed anchor state is only worth something off the volume that holds the database it anchors. */
export function checkAuditStateDir(i: DoctorInputs): DoctorCheck[] {
  const dir = i.auditStateDir;
  if (!dir) return [];
  if (inside(i.dataDir, dir)) {
    return [
      warn(
        "audit_state_dir",
        "keys",
        "the audit anchor state is inside the data directory: whoever can restore or edit the volume restores matching anchors with it",
        "Set TURNTABLE_AUDIT_STATE_DIR to a separate mount or secrets volume, and set audit_anchor_sink_url to export anchors off this instance. See docs/security.mdx (audit integrity).",
      ),
    ];
  }
  return [pass("audit_state_dir", "keys", "the audit anchor state is outside the data directory")];
}

export function checkMasterKey(i: DoctorInputs): DoctorCheck {
  const path = set(i.env.TURNTABLE_MASTER_KEY_FILE);
  const area = "keys";
  if (i.masterKeyEnv) {
    if (path) {
      return fail(
        "master_key",
        area,
        "TURNTABLE_MASTER_KEY and TURNTABLE_MASTER_KEY_FILE are both set",
        "Use one. Remove TURNTABLE_MASTER_KEY_FILE once the key is in the variable.",
      );
    }
    // A key file left in the data directory is the thing the variable was meant to get rid of:
    // every volume backup would still carry it. Any 32-byte `*.key` file counts.
    const stray = (i.fs.list?.(i.dataDir) ?? []).filter((n) => {
      if (!n.endsWith(".key")) return false;
      const f = i.fs.stat(join(i.dataDir, n));
      return f !== undefined && !f.isDirectory && f.size === 32;
    });
    if (stray.length > 0) {
      return warn(
        "master_key",
        area,
        `the master key comes from TURNTABLE_MASTER_KEY, but the data directory still holds a key file (${stray.join(", ")}): volume backups carry it`,
        "Once a backup taken after the re-wrap exists, delete the file from the volume, then rotate the GitHub App private key, the webhook secret and the vault secrets so the copies in older backups are dead.",
      );
    }
    return pass(
      "master_key",
      area,
      "the master key comes from TURNTABLE_MASTER_KEY, off the data volume",
    );
  }
  if (!path) {
    const what =
      "without a master key there is no vault, secrets store, GitHub App, OIDC issuer or signed audit checkpoints";
    const fix =
      "Set TURNTABLE_MASTER_KEY (`openssl rand -base64 32`), or create a file with `turntable keys init` and set TURNTABLE_MASTER_KEY_FILE.";
    return i.hosted
      ? fail("master_key", area, `no master key is configured: ${what}`, fix)
      : warn("master_key", area, `no master key is configured: ${what}`, fix);
  }
  const f = i.fs.stat(path);
  if (!f) {
    return fail(
      "master_key",
      area,
      "the master key file named by TURNTABLE_MASTER_KEY_FILE does not exist",
      "Create it with `turntable keys init --file <path>`, or restore it from backup. Without it sealed values cannot be read.",
    );
  }
  if (f.size !== 32) {
    return fail(
      "master_key",
      area,
      `the master key file is ${f.size} bytes, not 32`,
      "Restore the original key from backup. Do not edit it: a wrong key cannot open existing records.",
    );
  }
  if ((f.mode & 0o077) !== 0) {
    return warn(
      "master_key",
      area,
      `the master key file is readable by group or others (mode ${f.mode.toString(8)})`,
      "chmod 600 the file, and keep it out of the data directory's backups unless they are encrypted.",
    );
  }
  if (inside(i.dataDir, path)) {
    return warn(
      "master_key",
      area,
      "the master key file is inside the data directory: every volume backup holds the key next to what it unseals",
      KEY_ON_VOLUME_FIX,
    );
  }
  return pass(
    "master_key",
    area,
    "the master key file exists, is 32 bytes and is private to its owner",
  );
}

export async function checkDatabase(i: DoctorInputs): Promise<DoctorCheck[]> {
  const area = "database";
  if (!i.db && i.openError === MISSING_DATABASE) {
    return [
      warn(
        "database",
        area,
        "the database does not exist yet",
        "It is created at first start: run `turntable serve` once, from the data directory you mean to use.",
      ),
    ];
  }
  if (!i.db) {
    return [
      fail(
        "database",
        area,
        "the database cannot be opened",
        "Check the data directory and that no other process holds a lock on turntable.db.",
        i.openError?.slice(0, 160),
      ),
    ];
  }
  const out: DoctorCheck[] = [];
  try {
    await i.db.all(sql`SELECT 1 AS ok`);
    out.push(pass("database", area, "the database answers"));
  } catch (e) {
    return [
      fail(
        "database",
        area,
        "the database does not answer",
        "Check the file's permissions and free disk space.",
        String(e).slice(0, 160),
      ),
    ];
  }
  let applied: string[];
  try {
    applied = (await i.db.all(sql`SELECT tag FROM __turntable_migrations`)).map((r) =>
      String(r.tag),
    );
  } catch {
    out.push(
      warn(
        "migrations",
        area,
        "the database has no migration record yet",
        "It is created at first start: run `turntable serve` once.",
      ),
    );
    return out;
  }
  const expected = new Set(i.expectedMigrations);
  const pending = i.expectedMigrations.filter((t) => !applied.includes(t));
  const unknown = applied.filter((t) => !expected.has(t));
  if (unknown.length > 0) {
    out.push(
      fail(
        "migrations",
        area,
        `the database has ${unknown.length} migration(s) this binary does not know: it was written by a newer version`,
        "Do not run this binary against it. Use the newer version, or restore a backup taken before the upgrade.",
      ),
    );
  } else if (pending.length > 0) {
    out.push(
      warn(
        "migrations",
        area,
        `${pending.length} migration(s) are pending and will run when the server starts`,
        "Back up the data directory first: migrations only go forward.",
      ),
    );
  } else {
    out.push(pass("migrations", area, `all ${applied.length} migrations are applied`));
  }
  return out;
}

/** The GitHub App's credentials: the app is registered, and its key and webhook secret open. */
export async function checkGithubApp(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "github";
  const none = (): DoctorCheck =>
    i.hosted
      ? fail(
          "github_app",
          area,
          "no GitHub App is configured",
          "Run `turntable github-app create --url <public url>`, or set up the App for hosted use.",
        )
      : warn(
          "github_app",
          area,
          "no GitHub App is configured: only polling and local runs are possible",
          "Run `turntable github-app create --url <public url>` to receive webhooks and report checks.",
        );
  if (!i.db)
    return fail(
      "github_app",
      area,
      "not checked: the database is not open",
      "Fix the database first.",
    );
  const db = i.db;
  let app: { org_id: string } | undefined;
  try {
    app = (await i.db.all(sql`SELECT org_id FROM github_apps ORDER BY created_at LIMIT 1`))[0] as
      { org_id: string } | undefined;
  } catch {
    return none();
  }
  if (!app) return none();
  const key = i.masterKey();
  if (!key)
    return fail(
      "github_app",
      area,
      "the App exists but the master key is not available to check its credentials",
      "Set TURNTABLE_MASTER_KEY_FILE to the key the App was created with.",
    );
  const opens = async (name: string): Promise<"ok" | "missing" | "unreadable"> => {
    const row = (
      await db.all(
        sql`SELECT ciphertext FROM secrets WHERE org_id = ${app!.org_id} AND name = ${name}`,
      )
    )[0];
    if (!row) return "missing";
    try {
      return open(key, String(row.ciphertext), secretAad(app!.org_id, name), "system", app!.org_id)
        .length > 0
        ? "ok"
        : "missing";
    } catch {
      return "unreadable";
    }
  };
  const state = {
    "app id": await opens(SECRET_APP_ID),
    "private key": await opens(SECRET_PRIVATE_KEY),
    "webhook secret": await opens(SECRET_WEBHOOK),
  };
  const bad = Object.entries(state).filter(([, v]) => v !== "ok");
  if (bad.length === 0)
    return pass(
      "github_app",
      area,
      "the GitHub App is configured; its id, private key and webhook secret are present and open",
    );
  return fail(
    "github_app",
    area,
    `GitHub App credentials not usable: ${bad.map(([n, v]) => `${n} ${v}`).join(", ")}`,
    bad.some(([, v]) => v === "unreadable")
      ? "A record does not open under this master key: use the key the App was created with, or restore from backup."
      : "Re-create the App with `turntable github-app create`, or rotate the webhook secret with `turntable github-app rotate-webhook-secret`.",
  );
}

/** The public TLS listener's certificate for the secrets proxy: valid now, not about to expire, for the right name. */
export function checkProxyTls(i: DoctorInputs): DoctorCheck {
  const area = "proxy";
  const certPath = set(i.env.TURNTABLE_PROXY_TLS_CERT_FILE);
  const keyPath = set(i.env.TURNTABLE_PROXY_TLS_KEY_FILE);
  if (!certPath && !keyPath)
    return pass("proxy_tls", area, "no public TLS listener is configured for the secrets proxy");
  if (!certPath || !keyPath)
    return fail(
      "proxy_tls",
      area,
      "only one of the proxy's TLS certificate and key is set",
      "Set both TURNTABLE_PROXY_TLS_CERT_FILE and TURNTABLE_PROXY_TLS_KEY_FILE.",
    );
  const certPem = i.fs.read(certPath, 64 * 1024);
  const keyPem = i.fs.read(keyPath, 64 * 1024);
  if (!certPem || !keyPem)
    return fail(
      "proxy_tls",
      area,
      "the proxy's TLS certificate or key file cannot be read",
      "Check the paths and that the service user can read both files.",
    );
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return fail(
      "proxy_tls",
      area,
      "the proxy's TLS certificate is not a valid PEM certificate",
      "Provide the certificate in PEM form.",
    );
  }
  try {
    if (!cert.checkPrivateKey(createPrivateKey(keyPem)))
      return fail(
        "proxy_tls",
        area,
        "the proxy's TLS key does not belong to its certificate",
        "Use the key that matches the certificate.",
      );
  } catch {
    return fail(
      "proxy_tls",
      area,
      "the proxy's TLS key is not a valid PEM private key",
      "Provide the key in PEM form, unencrypted.",
    );
  }
  const now = i.now();
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (now < from)
    return fail(
      "proxy_tls",
      area,
      "the proxy's TLS certificate is not valid yet",
      "Check the certificate's dates and this machine's clock.",
    );
  if (now > to)
    return fail(
      "proxy_tls",
      area,
      `the proxy's TLS certificate expired ${Math.ceil((now - to) / DAY)} day(s) ago`,
      "Renew it and restart the server.",
    );
  const host = set(i.env.TURNTABLE_PROXY_ADVERTISE_HOST);
  if (host && !cert.checkHost(host))
    return warn(
      "proxy_tls",
      area,
      `the proxy's TLS certificate does not name its advertised host ${host}`,
      "Issue a certificate for that host name, or fix TURNTABLE_PROXY_ADVERTISE_HOST.",
    );
  const left = Math.floor((to - now) / DAY);
  return left < CERT_WARN_DAYS
    ? warn(
        "proxy_tls",
        area,
        `the proxy's TLS certificate expires in ${left} day(s)`,
        "Renew it and restart the server.",
      )
    : pass("proxy_tls", area, `the proxy's TLS certificate is valid for ${left} more days`);
}

/** Forwarded headers the server saw, against what it was told to trust. */
export function checkForwarded(i: DoctorInputs): DoctorCheck {
  const area = "network";
  const trustProto = i.env.TURNTABLE_TRUST_FORWARDED_PROTO === "1";
  const trustedProxies = set(i.env.TURNTABLE_TRUSTED_PROXIES) !== undefined;
  if (!i.observed) {
    return pass(
      "forwarded_headers",
      area,
      `forwarded-header trust is ${trustProto ? "on" : "off"} for protocol and ${trustedProxies ? "set" : "unset"} for client addresses (the live server compares this with what it sees: run doctor through the API to include that)`,
    );
  }
  const o = i.observed;
  if (o.requests === 0)
    return pass(
      "forwarded_headers",
      area,
      "no requests have been seen yet, so the settings could not be compared with real traffic",
    );
  const problems: string[] = [];
  if (o.withForwardedProto > 0 && !trustProto)
    problems.push(
      `${o.withForwardedProto} request(s) carried X-Forwarded-Proto but TURNTABLE_TRUST_FORWARDED_PROTO is not set, so http is not redirected to https and value-bearing requests behind the proxy are refused`,
    );
  if (o.withForwardedFor > 0 && !trustedProxies)
    problems.push(
      `${o.withForwardedFor} request(s) carried X-Forwarded-For but TURNTABLE_TRUSTED_PROXIES is empty, so rate limits key on the proxy's address, not the client's`,
    );
  if (trustProto && o.withForwardedProto === 0)
    problems.push(
      "TURNTABLE_TRUST_FORWARDED_PROTO is set but no request carried X-Forwarded-Proto: is the proxy in front of this server?",
    );
  if (trustedProxies && o.withForwardedFor === 0)
    problems.push("TURNTABLE_TRUSTED_PROXIES is set but no request carried X-Forwarded-For");
  return problems.length === 0
    ? pass(
        "forwarded_headers",
        area,
        `forwarded-header settings match the ${o.requests} request(s) seen`,
      )
    : warn(
        "forwarded_headers",
        area,
        problems.join("; "),
        "Set TURNTABLE_TRUST_FORWARDED_PROTO=1 and name your proxies in TURNTABLE_TRUSTED_PROXIES when a proxy you control is in front; clear them when none is.",
      );
}

/** Plain http is redirected to https, here or by the proxy in front. */
export function checkHttpsRedirect(i: DoctorInputs): DoctorCheck {
  const area = "network";
  const trustProto = i.env.TURNTABLE_TRUST_FORWARDED_PROTO === "1";
  const hsts = i.env.TURNTABLE_HSTS_MAX_AGE?.trim().toLowerCase();
  if (hsts === "off" || hsts === "0")
    return warn(
      "https_redirect",
      area,
      "HSTS is turned off",
      "Unset TURNTABLE_HSTS_MAX_AGE (the default is one year) unless something in front sends it.",
    );
  if (trustProto)
    return pass(
      "https_redirect",
      area,
      "behind a trusted proxy, http requests get a 301 to https and https responses carry HSTS",
    );
  return i.hosted
    ? fail(
        "https_redirect",
        area,
        "plain http is not redirected here: no trusted proxy is configured",
        "Set TURNTABLE_TRUST_FORWARDED_PROTO=1 behind a proxy you control, and turn on the proxy's Always Use HTTPS as well.",
      )
    : warn(
        "https_redirect",
        area,
        "plain http is not redirected by this server (no trusted proxy is configured)",
        "On a public site set TURNTABLE_TRUST_FORWARDED_PROTO=1 behind your proxy and enable its Always Use HTTPS. Loopback development needs neither.",
      );
}

export async function checkChannel(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "release";
  const configured = set(i.env.TURNTABLE_PUBLISH_CHANNEL_KEY_FILE);
  if (!configured || !i.channel)
    return pass(
      "release_channel",
      area,
      "no release channel is configured, so compat publishing is off",
    );
  const keyFile = i.fs.stat(configured);
  if (!keyFile)
    return fail(
      "release_channel",
      area,
      "the release channel key file does not exist",
      "Create it, with the same content as the key file the release lane uses for its channel.",
    );
  if ((keyFile.mode & 0o077) !== 0)
    return warn(
      "release_channel",
      area,
      "the release channel key file is readable by group or others",
      "chmod 600 it.",
    );
  const r = await i.channel();
  return r.ok
    ? pass(
        "release_channel",
        area,
        "the release lane answers over the channel and accepts this process's request key",
      )
    : fail(
        "release_channel",
        area,
        `the release lane channel is not usable: ${r.reason}`,
        "Check that the lane is running with the channel enabled, the socket or address matches, and both sides hold the same key.",
        r.detail,
      );
}

export async function checkQuotas(i: DoctorInputs): Promise<DoctorCheck> {
  const area = "limits";
  if (!i.db)
    return fail("quotas", area, "not checked: the database is not open", "Fix the database first.");
  if (!(await i.db.hasTable("org_quotas")))
    return pass("quotas", area, "this build has no per-org quotas");
  const n = Number((await i.db.all(sql`SELECT count(*) AS n FROM org_quotas`))[0]?.n ?? 0);
  if (n > 0) return pass("quotas", area, `${n} org(s) have quotas set`);
  return i.hosted
    ? warn(
        "quotas",
        area,
        "no quotas are set: every org can use unlimited sandbox time, log and artifact storage",
        "Set limits with the `set_quotas` operation before opening the instance to other people.",
      )
    : pass("quotas", area, "no quotas are set: every org is unlimited (fine for one operator)");
}

/** The failures in a row at which a repo's polling is reported as unhealthy. */
export const POLL_FAILURE_WARN = 3;

/**
 * Poll health from the in-process poller snapshot: fixed sentences, no repo names or error text.
 * A process with no poller (or none polling yet) passes: there is nothing to be unhealthy.
 */
export function checkPollHealth(): DoctorCheck {
  const area = "ingest";
  const repos = [...ingestStatus.repos.values()];
  const failing = repos.filter((r) => r.consecutiveFailures >= POLL_FAILURE_WARN).length;
  const anonymousLow = repos.some(
    (r) =>
      r.authMode === "anonymous" &&
      r.rateLimit?.remaining !== undefined &&
      r.rateLimit.remaining <= POLL_RESERVE,
  );
  if (failing > 0 || anonymousLow) {
    return warn(
      "poll_health",
      area,
      failing > 0 && anonymousLow
        ? "some repos keep failing to poll and the anonymous GitHub budget is nearly spent"
        : failing > 0
          ? "some repos have failed to poll several times in a row"
          : "the anonymous GitHub budget is nearly spent",
      "Run `instance_ingest_status` for each repo's error class and budget; set a poll token or install the GitHub App to raise the budget.",
    );
  }
  return pass("poll_health", area, "no repo is failing to poll and the poll budget has room");
}

/** Every check, in a fixed order. A check that throws is reported as a fail, never as a crash. */
export async function runDoctor(i: DoctorInputs): Promise<DoctorReport> {
  const safe = async (
    id: string,
    area: string,
    fn: () => DoctorCheck[] | Promise<DoctorCheck[]> | DoctorCheck | Promise<DoctorCheck>,
  ): Promise<DoctorCheck[]> => {
    try {
      const r = await fn();
      return Array.isArray(r) ? r : [r];
    } catch (e) {
      return [
        fail(
          id,
          area,
          "the check itself failed",
          "This is a bug in doctor: report it.",
          String(e).slice(0, 120),
        ),
      ];
    }
  };
  const all = [
    ...(await safe("privileges", "process", () => checkPrivileges(i))),
    ...(await safe("master_key", "keys", () => checkMasterKey(i))),
    ...(await safe("release_key", "keys", () => checkReleaseKey(i))),
    ...(await safe("audit_anchor", "keys", () => checkAuditAnchors(i))),
    ...(await safe("audit_state_dir", "keys", () => checkAuditStateDir(i))),
    ...(await safe("database", "database", () => checkDatabase(i))),
    ...(await safe("github_app", "github", () => checkGithubApp(i))),
    ...(await safe("provider", "provider", () => i.providerChecks())),
    ...(await safe("proxy_tls", "proxy", () => checkProxyTls(i))),
    ...(await safe("forwarded_headers", "network", () => checkForwarded(i))),
    ...(await safe("https_redirect", "network", () => checkHttpsRedirect(i))),
    ...(await safe("release_channel", "release", () => checkChannel(i))),
    ...(await safe("quotas", "limits", () => checkQuotas(i))),
    ...(await safe("poll_health", "ingest", () => checkPollHealth())),
  ];
  return report(all);
}
