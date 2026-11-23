// instance_ingest_status (#399): poll health across orgs for the instance administrator, with
// classified errors only, and the doctor's poll_health check.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import { listAudit, type Db } from "../src/db";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { AGENT_ROLES } from "../src/db/schema";
import { checkPollHealth } from "../src/doctor/checks";
import { dispatch, type DispatchEnv, registry, type Credential, type Principal } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import {
  classifyPollError,
  ingestStatus,
  POLL_RESERVE,
  resetIngestStatus,
  type RepoStatus,
} from "../src/poll/status";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let secret: string;

// Built at run time: no secret-like literal in the file.
const fakeToken = () => `ghp_${"Q7".repeat(18)}`;

const repo = (
  over: Partial<RepoStatus> & Pick<RepoStatus, "repo" | "org" | "project">,
): RepoStatus => ({
  lastPollAt: Date.UTC(2026, 10, 23, 1),
  lastOutcome: "ok",
  lastError: null,
  nextPollAt: Date.UTC(2026, 10, 23, 1, 1),
  consecutiveFailures: 0,
  runsCreated: 0,
  authMode: "anonymous",
  rateLimit: undefined,
  ...over,
});
const put = (r: RepoStatus) => ingestStatus.repos.set(r.repo, r);
const rate = (remaining: number) => ({
  limit: 60,
  remaining,
  resetAt: Date.UTC(2026, 10, 23, 2),
  resource: "core",
  observedAt: Date.UTC(2026, 10, 23, 1),
});

beforeEach(async () => {
  resetIngestStatus();
  ({ db, a, b } = await seedWorld());
  env = { registry, db, allowInstance: true, instanceOrgCap: 4 };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
});
afterEach(() => resetIngestStatus());

const call = (e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, "instance_ingest_status", {});

describe("instance_ingest_status", () => {
  test("a tti_ token sees repos from two orgs", async () => {
    ingestStatus.running = true;
    put(repo({ repo: "x/one", org: a.slug, project: "p1", authMode: "token" }));
    put(
      repo({
        repo: "y/two",
        org: b.slug,
        project: "p2",
        authMode: "installation",
        rateLimit: rate(40),
      }),
    );
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as {
      running: boolean;
      repos: { org: string; project: string; repo: string; auth_mode: string }[];
      rate_limit_by_mode: { installation: { remaining: number } | null };
    };
    expect(out.running).toBe(true);
    expect(out.repos.map((x) => [x.org, x.project, x.repo, x.auth_mode])).toEqual([
      [a.slug, "p1", "x/one", "token"],
      [b.slug, "p2", "y/two", "installation"],
    ]);
    expect(out.rate_limit_by_mode.installation?.remaining).toBe(40);
  });

  test("a raw error, token and URL query never appear: classes only", async () => {
    const raw = `GitHub API 502 for /repos/x/one?token=${fakeToken()} https://h.example/a?token=${fakeToken()}`;
    put(
      repo({
        repo: "x/one",
        org: a.slug,
        project: "p1",
        lastOutcome: "error",
        lastError: raw,
        consecutiveFailures: 2,
      }),
    );
    put(
      repo({
        repo: "x/two",
        org: a.slug,
        project: "p1",
        lastOutcome: "error",
        lastError: `weird ${fakeToken()} https://h.example/?token=${fakeToken()}`,
      }),
    );
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = JSON.stringify(r.output);
    expect(text).not.toContain(fakeToken());
    expect(text).not.toContain("token=");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("last_error");
    const out = r.output as { repos: { error_class: string }[] };
    expect(out.repos.map((x) => x.error_class)).toEqual(["github_5xx", "unknown"]);
    expect(r.untrusted).toBe(false);
  });

  test("classifies failures", () => {
    const c = (lastOutcome: RepoStatus["lastOutcome"], lastError: string | null) =>
      classifyPollError({ lastOutcome, lastError });
    expect(c("ok", null)).toBeNull();
    expect(c(null, null)).toBeNull();
    expect(c("rate_limited", "rate limited by GitHub")).toBe("rate_limited");
    expect(c("error", "GitHub API 404 for /repos/x")).toBe("not_found");
    expect(c("error", "GitHub API 401 for /repos/x")).toBe("auth");
    expect(c("error", "GitHub API 403 for /repos/x")).toBe("auth");
    expect(c("error", "GitHub API 422 for /repos/x")).toBe("github_4xx");
    expect(c("error", "GitHub API 503 for /repos/x")).toBe("github_5xx");
    expect(c("error", "fetch failed")).toBe("network");
    expect(c("error", "bound to another project; poll entry is stale")).toBe("stale_binding");
  });

  test("is audited as a read in the system chain", async () => {
    await call();
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    const mine = rows.filter((x) => x.op === "instance_ingest_status");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.effect === "read")).toBe(true);
  });

  test("org tokens of every role, members and MCP are refused", async () => {
    put(repo({ repo: "x/one", org: a.slug, project: "p1" }));
    for (const t of [a, b]) {
      const creds: Credential[] = [];
      for (const role of AGENT_ROLES) {
        creds.push({
          kind: "bearer",
          token: (await mintToken(db, { orgId: t.orgId }, role)).secret,
        });
      }
      const owner: Principal = { kind: "member", id: `o-${t.slug}`, orgId: t.orgId, role: "owner" };
      creds.push({ kind: "principal", principal: owner });
      for (const cred of creds) {
        const r = await dispatch(env, cred, "instance_ingest_status", {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("forbidden");
      }
    }
    const op = registry.ops.find((o) => o.name === "instance_ingest_status")!;
    expect(op.mcp).toBe(false);
    expect(op.effect).toBe("read");
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_ingest_status");
    const plain = await dispatch(
      { registry, db },
      { kind: "bearer", token: secret },
      "instance_ingest_status",
      {},
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
  });
});

describe("doctor poll_health", () => {
  test("passes with no poller and with healthy repos", () => {
    expect(checkPollHealth()).toMatchObject({ id: "poll_health", status: "pass" });
    put(repo({ repo: "x/one", org: a.slug, project: "p1", rateLimit: rate(30) }));
    put(repo({ repo: "x/two", org: a.slug, project: "p1", consecutiveFailures: 2 }));
    expect(checkPollHealth().status).toBe("pass");
  });

  test("warns at 3 consecutive failures, with a fixed sentence naming no repo", () => {
    put(
      repo({
        repo: "x/secretname",
        org: a.slug,
        project: "p1",
        lastOutcome: "error",
        lastError: `boom ${fakeToken()}`,
        consecutiveFailures: 3,
      }),
    );
    const c = checkPollHealth();
    expect(c.status).toBe("warn");
    expect(JSON.stringify(c)).not.toContain("secretname");
    expect(JSON.stringify(c)).not.toContain(fakeToken());
  });

  test("warns when the anonymous budget is at its floor, not for a token budget", () => {
    put(repo({ repo: "x/one", org: a.slug, project: "p1", rateLimit: rate(POLL_RESERVE + 1) }));
    expect(checkPollHealth().status).toBe("pass");
    put(repo({ repo: "x/low", org: a.slug, project: "p1", authMode: "token", rateLimit: rate(0) }));
    expect(checkPollHealth().status).toBe("pass");
    put(repo({ repo: "x/anon", org: a.slug, project: "p1", rateLimit: rate(POLL_RESERVE) }));
    expect(checkPollHealth().status).toBe("warn");
  });
});
