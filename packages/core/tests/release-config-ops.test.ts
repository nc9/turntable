// Release lane configuration for shell-less instances (#541): the instance administrator's ops,
// each behind a passkey step-up, writing the lane's own file and vault through its config channel.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemOrgId } from "../src/audit/failures";
import { chainedAudit, createOrg, createProject, ensureInstance, openDatabase } from "../src/db";
import type { Db } from "../src/db";
import * as s from "../src/db/schema";
import { mcpTools } from "../src/ops/mcp";
import { dispatch, registry } from "../src/ops";
import { AttestationStore } from "../src/release/attest";
import { releaseCommand } from "../src/release/cli";
import { opsHarness, type Harness } from "./release-config-helpers";
import { seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let attest: AttestationStore;
let h: Harness;

const NPM = (t: Tenant, over: Record<string, unknown> = {}) => ({
  target_org: t.slug,
  target_project: t.projectSlug,
  key: "npm",
  kind: "npm",
  package: "@acme/web",
  artifact: "web-1.0.0.tgz",
  secret: "NPM_TOKEN",
  accept_long_lived_token: true,
  ...over,
});
const PIN = (t: Tenant, repo = "acme/web") => ({
  target_org: t.slug,
  target_project: t.projectSlug,
  repo,
});

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  attest = new AttestationStore(":memory:");
  h = await opsHarness({ db, attest, orgId: a.orgId });
});
afterEach(() => {
  h.dispose();
  attest.close();
});

describe("each op round-trips through the lane's own file", () => {
  test("pin, declare, set a secret, list, delete", async () => {
    const v0 = attest.configVersion();
    const pin = await h.signedCall("release_pin_repo", PIN(a, "Acme/Web"));
    expect(pin.ok && pin.output).toMatchObject({ repo: "acme/web" });
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBe("acme/web");

    const set = await h.signedCall("release_publish_target_set", NPM(a));
    expect(set.ok && set.output).toMatchObject({ key: "npm", kind: "npm" });
    expect(attest.publishTargets(a.orgId, a.projectId).npm).toMatchObject({
      kind: "npm",
      package: "@acme/web",
      secret: "NPM_TOKEN",
    });

    const value = randomBytes(12).toString("hex");
    const sec = await h.signedCall("release_secret_set", {
      target_org: a.slug,
      target_project: a.projectSlug,
      name: "NPM_TOKEN",
      value,
    });
    expect(sec.ok && sec.output).toMatchObject({ name: "NPM_TOKEN", created: true });

    // every change moved the lane's config version, and each answer carries the new one
    expect(attest.configVersion()).toBe(v0 + 3);
    expect(sec.ok && (sec.output as { config_version: number }).config_version).toBe(v0 + 3);

    const list = await h.call("release_publish_target_list", {
      target_org: a.slug,
      target_project: a.projectSlug,
    });
    expect(list.ok && list.output).toMatchObject({
      pinned_repo: "acme/web",
      config_version: v0 + 3,
      targets: [{ key: "npm", kind: "npm", mode: "strict", has_credential: true }],
    });

    const del = await h.signedCall("release_publish_target_delete", {
      target_org: a.slug,
      target_project: a.projectSlug,
      key: "npm",
    });
    expect(del.ok && del.output).toMatchObject({ removed: true });
    expect(attest.publishTargets(a.orgId, a.projectId)).toEqual({});
    expect(attest.configVersion()).toBe(v0 + 4);
  });

  test("a target the lane would refuse is refused with the CLI's reason, and nothing is written", async () => {
    const noAccept = await h.signedCall("release_publish_target_set", {
      ...NPM(a),
      accept_long_lived_token: false,
    });
    expect(!noAccept.ok && noAccept.error.code).toBe("invalid_input");
    expect(!noAccept.ok && noAccept.error.message).toContain("long-lived");
    const badPkg = await h.signedCall(
      "release_publish_target_set",
      NPM(a, { package: "Bad Name" }),
    );
    expect(!badPkg.ok && badPkg.error.message).toContain("package must be a valid npm name");
    const badKey = await h.signedCall("release_publish_target_set", NPM(a, { key: "Bad_Key" }));
    expect(!badKey.ok && badKey.error.code).toBe("invalid_input");
    const badRepo = await h.signedCall("release_pin_repo", PIN(a, "not a repo"));
    expect(!badRepo.ok && badRepo.error.message).toBe("repo must be owner/name");
    expect(attest.publishTargets(a.orgId, a.projectId)).toEqual({});
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBeUndefined();
  });

  test("a secret is refused until a target names it, and an empty value is refused", async () => {
    const noTarget = await h.signedCall("release_secret_set", {
      target_org: a.slug,
      target_project: a.projectSlug,
      name: "NPM_TOKEN",
      value: "x".repeat(8),
    });
    expect(!noTarget.ok && noTarget.error.message).toContain("declare the target first");
    await h.signedCall("release_publish_target_set", NPM(a));
    const empty = await h.signedCall("release_secret_set", {
      target_org: a.slug,
      target_project: a.projectSlug,
      name: "NPM_TOKEN",
      value: "",
    });
    expect(!empty.ok && empty.error.code).toBe("invalid_input");
  });
});

describe("the CLI and the ops share one file", () => {
  test("the CLI sees what an op wrote, and an op lists what the CLI wrote", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tt-cli-"));
    const saved = { ...process.env };
    const logged: string[] = [];
    const realLog = console.log;
    try {
      const dataDir = join(tmp, "data");
      const relDir = join(tmp, "rel");
      // The CLI opens the main database by path: a file world with the same org and project.
      const fileDb = openDatabase(join(dataDir, "turntable.db"));
      await ensureInstance(fileDb);
      const org = await createOrg(fileDb, { slug: "acme", name: "acme" });
      const proj = await createProject(fileDb, { orgId: org.id }, { slug: "web", name: "web" });
      fileDb.close();
      Object.assign(process.env, {
        TURNTABLE_RELEASE_MASTER_KEY_FILE: join(tmp, "release.key"),
        TURNTABLE_RELEASE_DATA_DIR: relDir,
        TURNTABLE_RELEASE_GITHUB_TOKEN: "t",
        TURNTABLE_RELEASE_ARTIFACT_DIR: join(tmp, "art"),
        TURNTABLE_RELEASE_BUILDER_ID: "https://ci.example.com",
      });
      const base = ["--org", "acme", "--project", "web", "--data-dir", dataDir];
      // CLI writes first
      expect(await releaseCommand(["pin-repo", ...base, "--repo", "Acme/Web"])).toBe(0);
      expect(
        await releaseCommand([
          "publish-target",
          "set",
          ...base,
          "--key",
          "gh",
          "--kind",
          "github-release",
          "--assets",
          "a,b",
        ]),
      ).toBe(0);

      // the ops, on the same lane file
      const db2 = openDatabase(join(dataDir, "turntable.db"));
      const laneFile = new AttestationStore(join(relDir, "attested.db"));
      const h2 = await opsHarness({ db: db2, attest: laneFile, orgId: org.id });
      const t = { slug: "acme", projectSlug: "web" } as Tenant;
      try {
        const seen = await h2.call("release_publish_target_list", {
          target_org: "acme",
          target_project: "web",
        });
        expect(seen.ok && seen.output).toMatchObject({
          pinned_repo: "acme/web",
          targets: [{ key: "gh", kind: "github-release" }],
        });
        const set = await h2.signedCall("release_publish_target_set", NPM(t));
        expect(set.ok).toBe(true);
        const pin = await h2.signedCall("release_pin_repo", PIN(t, "acme/web2"));
        expect(pin.ok).toBe(true);
      } finally {
        h2.dispose();
        laneFile.close();
        db2.close();
      }
      // the CLI reads what the op wrote, through the same file and the same version counter
      console.log = (m: unknown) => void logged.push(String(m));
      expect(await releaseCommand(["publish-target", "list", ...base])).toBe(0);
      console.log = realLog;
      expect(logged.join("\n")).toContain('npm: {"kind":"npm"');
      expect(logged.join("\n")).toContain('gh: {"kind":"github-release"');
      const check = new AttestationStore(join(relDir, "attested.db"));
      expect(check.pinnedRepo(org.id, proj.id)).toBe("acme/web2");
      // CLI pin + CLI target + op target + op pin: the counter moved on every one of them
      expect(check.configVersion()).toBe(4);
      check.close();
    } finally {
      console.log = realLog;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("a write needs the step-up, for exactly this op and this input", () => {
  test("no step-up: refused, with the reason, and nothing changed", async () => {
    const r = await h.call("release_pin_repo", PIN(a));
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(!r.ok && r.error.details).toEqual({ reason: "step_up_required" });
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBeUndefined();
    expect(attest.configVersion()).toBe(0);
    // refused and audited in the operator org's chain
    const audit = await chainedAudit(db, a.orgId, 0, 100);
    expect(audit.some((e) => e.op === "release_pin_repo" && e.outcome === "error:forbidden")).toBe(
      true,
    );
  });

  test("a step-up for another op is refused", async () => {
    const su = await h.stepUpFor("release_publish_target_delete", {
      target_org: a.slug,
      target_project: a.projectSlug,
      key: "npm",
    });
    const r = await h.call("release_pin_repo", PIN(a), su);
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(!r.ok && r.error.details).toEqual({ reason: "step_up_wrong_action" });
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBeUndefined();
  });

  test("a step-up for other input is refused: another repo, another target field, another secret value", async () => {
    const su = await h.stepUpFor("release_pin_repo", PIN(a, "acme/web"));
    const wrongRepo = await h.call("release_pin_repo", PIN(a, "acme/evil"), su);
    expect(!wrongRepo.ok && wrongRepo.error.details).toEqual({ reason: "step_up_wrong_action" });

    const su2 = await h.stepUpFor("release_publish_target_set", NPM(a));
    const other = await h.call(
      "release_publish_target_set",
      NPM(a, { package: "@acme/evil" }),
      su2,
    );
    expect(!other.ok && other.error.details).toEqual({ reason: "step_up_wrong_action" });
    expect(attest.publishTargets(a.orgId, a.projectId)).toEqual({});

    await h.signedCall("release_publish_target_set", NPM(a));
    const name = { target_org: a.slug, target_project: a.projectSlug, name: "NPM_TOKEN" };
    const su3 = await h.stepUpFor("release_secret_set", { ...name, value: "approved-value-1" });
    const swapped = await h.call("release_secret_set", { ...name, value: "another-value-22" }, su3);
    expect(!swapped.ok && swapped.error.details).toEqual({ reason: "step_up_wrong_action" });
    // and the same one still authorizes the value it was given
    const same = await h.call("release_secret_set", { ...name, value: "approved-value-1" }, su3);
    expect(same.ok).toBe(true);
  });

  test("a step-up is single use", async () => {
    const su = await h.stepUpFor("release_pin_repo", PIN(a));
    expect((await h.call("release_pin_repo", PIN(a), su)).ok).toBe(true);
    const again = await h.call("release_pin_repo", PIN(a), su);
    expect(!again.ok && again.error.details).toEqual({ reason: "step_up_reused" });
    expect(attest.configVersion()).toBe(1);
  });

  test("a step-up is bound to the person that asked, and expires", async () => {
    const bob = await h.person({
      login: "bob",
      memberships: [{ orgId: a.orgId, role: "owner" }],
    });
    const su = await h.stepUpFor("release_pin_repo", PIN(a));
    const stolen = await h.call("release_pin_repo", PIN(a), su, bob.cookie);
    expect(!stolen.ok && stolen.error.details).toEqual({ reason: "step_up_unknown" });
    h.clock.now += 6 * 60_000;
    const late = await h.call("release_pin_repo", PIN(a), su);
    expect(!late.ok && late.error.details).toEqual({ reason: "step_up_expired" });
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBeUndefined();
  });

  test("a passkey that is not the caller's own cannot sign", async () => {
    const { passkey } = await import("./release-config-helpers");
    const rogue = passkey();
    const su = await h.stepUpFor("release_pin_repo", PIN(a), { device: rogue });
    const r = await h.call("release_pin_repo", PIN(a), su);
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(!r.ok && r.error.details).toEqual({ reason: "step_up_bad_key" });
    // an owner with no passkey enrolled cannot even start a step-up
    const bare = await h.person({
      login: "carol",
      memberships: [{ orgId: a.orgId, role: "owner" }],
      approverIn: [],
    });
    const none = await h.call(
      "session_step_up_challenge",
      { action: "release_pin_repo", input: PIN(a) },
      undefined,
      bare.cookie,
    );
    expect(!none.ok && none.error.code).toBe("conflict");
  });

  test("an org token of any kind holds none of this", async () => {
    const r = await dispatch(
      h.env,
      { kind: "principal", principal: a.admin },
      "release_pin_repo",
      PIN(a),
    );
    expect(!r.ok && r.error.code).toBe("forbidden");
  });
});

describe("not over MCP, and not without a lane", () => {
  const OPS = [
    "release_pin_repo",
    "release_publish_target_set",
    "release_publish_target_list",
    "release_publish_target_delete",
    "release_secret_set",
    "release_init_key",
    "release_set_project_signing",
    "release_key_show",
    "release_secret_status",
    "release_cosign_key_set",
    "release_cosign_key_remove",
    "release_cosign_key_list",
  ];

  test("every one is off MCP, and neither an instance token nor a session is a credential there", async () => {
    const { createInstanceTokenFromCli } = await import("../src/ops/instance-token-cli");
    const tti = (await createInstanceTokenFromCli(db, { name: "mcp probe" })).secret;
    for (const name of OPS) {
      expect(registry.get(name)!.mcp, name).toBe(false);
      expect(mcpTools(registry).map((t) => t.name)).not.toContain(name);
      // the dispatcher an MCP adapter builds does not let an instance token authenticate
      const r = await dispatch(
        { registry, db, transport: "mcp", viaMcp: true },
        { kind: "bearer", token: tti },
        name,
        {},
      );
      expect(!r.ok && r.error.code, name).toBe("unauthenticated");
      // a signed-in owner's session over MCP is refused too
      const viaMcp = await dispatch(
        { ...h.env, transport: "mcp", viaMcp: true },
        { kind: "session", cookie: h.cookie },
        name,
        { org: h.operator.slug },
      );
      expect(!viaMcp.ok && viaMcp.error.code, name).toBe("forbidden");
    }
  });

  test("with no lane configured on the instance every op is refused with the reason", async () => {
    const bare = await opsHarness({ db, attest, orgId: b.orgId, lane: false });
    try {
      const pin = await bare.signedCall("release_pin_repo", PIN(b));
      expect(!pin.ok && pin.error.code).toBe("unavailable");
      expect(!pin.ok && pin.error.message).toContain("release lane is not configured");
      expect(!pin.ok && pin.error.details).toEqual({ reason: "lane_not_configured" });
      const list = await bare.call("release_publish_target_list", {
        target_org: b.slug,
        target_project: b.projectSlug,
      });
      expect(!list.ok && list.error.details).toEqual({ reason: "lane_not_configured" });
      expect(attest.pinnedRepo(b.orgId, b.projectId)).toBeUndefined();
    } finally {
      bare.dispose();
    }
  });

  test("a lane that is down is a refusal, not a write", async () => {
    h.dispose();
    const r = await h.signedCall("release_pin_repo", PIN(a)).catch((e: unknown) => e);
    // the channel is gone: the op says so (a refused step-up is possible too, never a success)
    expect(r instanceof Error || (typeof r === "object" && r !== null && "ok" in r && !r.ok)).toBe(
      true,
    );
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBeUndefined();
  });
});

describe("a secret value is write-only", () => {
  test("the marker is in the lane's vault and nowhere else: outputs, audit, events, logs", async () => {
    const MARKER = ["mk", randomBytes(16).toString("hex")].join("_");
    const heard: string[] = [];
    const real = { ...console };
    for (const k of ["log", "info", "warn", "error", "debug"] as const) {
      console[k] = (...args: unknown[]) => void heard.push(args.map(String).join(" "));
    }
    const outputs: unknown[] = [];
    try {
      outputs.push(await h.signedCall("release_publish_target_set", NPM(a)));
      const name = { target_org: a.slug, target_project: a.projectSlug, name: "NPM_TOKEN" };
      const su = await h.stepUpFor("release_secret_set", { ...name, value: MARKER });
      outputs.push(su);
      const set = await h.call("release_secret_set", { ...name, value: MARKER }, su);
      outputs.push(set);
      expect(set.ok).toBe(true);
      // a refused attempt with the marker, too: its error must not echo it
      outputs.push(await h.call("release_secret_set", { ...name, value: MARKER }, su));
      outputs.push(
        await h.call("release_secret_set", { ...name, name: "bad name!", value: MARKER }),
      );
      outputs.push(
        await h.call("release_publish_target_list", {
          target_org: a.slug,
          target_project: a.projectSlug,
        }),
      );
    } finally {
      Object.assign(console, real);
    }

    // the lane's own decrypt gets it back, for the registry host the target names
    const used = await h.vault.usePublishCredential({
      orgId: a.orgId,
      projectId: a.projectId,
      name: "NPM_TOKEN",
      destination: "registry.npmjs.org",
      tag: "v1.0.0",
      requestId: "req-1",
    });
    expect(used).toMatchObject({ ok: true, value: MARKER });
    // ...and for no other host
    const elsewhere = await h.vault.usePublishCredential({
      orgId: a.orgId,
      projectId: a.projectId,
      name: "NPM_TOKEN",
      destination: "registry.evil.test",
      tag: "v1.0.0",
      requestId: "req-2",
    });
    expect(elsewhere).toMatchObject({ ok: false, reason: "destination_not_allowed" });

    // the write-only form's status read: when and by whom, never the value
    const status = await h.call("release_secret_status", {
      target_org: a.slug,
      target_project: a.projectSlug,
      name: "NPM_TOKEN",
    });
    outputs.push(status);
    expect(status.ok && status.output).toMatchObject({ set: true, set_by: "alice" });
    const none = await h.call("release_secret_status", {
      target_org: a.slug,
      target_project: a.projectSlug,
      name: "OTHER_TOKEN",
    });
    expect(none.ok && none.output).toEqual({ set: false, set_at: null, set_by: null });

    const text = (x: unknown) => JSON.stringify(x);
    expect(text(outputs)).not.toContain(MARKER);
    // the audit of every org involved, the system chain included
    const chains = [a.orgId, b.orgId, await systemOrgId(db)];
    const audit = (await Promise.all(chains.map((o) => chainedAudit(db, o, 0, 1000)))).flat();
    expect(text(audit)).not.toContain(MARKER);
    const row = audit.find((e) => e.op === "release_secret_set" && e.outcome === "ok");
    expect(row).toBeDefined();
    // the name, the project and who: the value redacted
    expect(JSON.parse(String(row!.input))).toMatchObject({
      name: "NPM_TOKEN",
      target_org: a.slug,
      target_project: a.projectSlug,
      value: "[redacted]",
    });
    expect(row!.principalKind).toBe("session");
    // events
    const events = await db.orm.select().from(s.events);
    expect(text(events)).not.toContain(MARKER);
    // the server's log capture, and the lane channel's own
    expect(heard.join("\n")).not.toContain(MARKER);
    expect(h.logs.join("\n")).not.toContain(MARKER);
  });
});

describe("the list shows the configuration with no secret material", () => {
  test("has_credential is true or false and nothing more", async () => {
    await h.signedCall("release_pin_repo", PIN(a));
    await h.signedCall("release_publish_target_set", NPM(a));
    await h.signedCall("release_publish_target_set", {
      target_org: a.slug,
      target_project: a.projectSlug,
      key: "oci",
      kind: "oci-image",
      registry: "ghcr.io",
      repository: "acme/web",
      manifest: "image.json",
      tags: ["v1"],
      username: "bot",
      secret: "GHCR_TOKEN",
    });
    const input = { target_org: a.slug, target_project: a.projectSlug };
    const before = await h.call("release_publish_target_list", input);
    const targetsOf = (r: typeof before) =>
      (r.ok ? (r.output as { targets: Record<string, unknown>[] }).targets : []).map((t) => ({
        key: t.key,
        has: t.has_credential,
      }));
    expect(targetsOf(before)).toEqual([
      { key: "npm", has: false },
      { key: "oci", has: false },
    ]);
    await h.signedCall("release_secret_set", {
      ...input,
      name: "NPM_TOKEN",
      value: "v".repeat(10),
    });
    const after = await h.call("release_publish_target_list", input);
    expect(targetsOf(after)).toEqual([
      { key: "npm", has: true },
      { key: "oci", has: false },
    ]);
    // the declaration names the vault secret and holds no value; no `secret` or token field at all
    const out = after.ok ? (after.output as { targets: { settings: object }[] }) : undefined;
    expect(Object.keys(out!.targets[0]!.settings)).toContain("vault_name");
    expect(Object.keys(out!.targets[0]!.settings)).not.toContain("secret");
    expect(JSON.stringify(after)).not.toContain("vvvvvvvvvv");
    // the list needs no step-up and is not an audited write
    expect(after.ok).toBe(true);
  });
});

describe("tenant isolation", () => {
  test("an op naming org A cannot reach org B's lane config through a mismatched project", async () => {
    // org B gets its own project, which org A does not have
    const bOnly = await createProject(db, { orgId: b.orgId }, { slug: "bonly", name: "B only" });
    const mismatched = { target_org: a.slug, target_project: "bonly" };
    for (const name of [
      "release_pin_repo",
      "release_publish_target_set",
      "release_publish_target_delete",
      "release_secret_set",
      "release_publish_target_list",
      "session_step_up_challenge",
    ]) {
      const input =
        name === "release_pin_repo"
          ? { ...mismatched, repo: "evil/x" }
          : name === "release_publish_target_set"
            ? { ...mismatched, ...NPM(a), target_project: "bonly" }
            : name === "release_publish_target_delete"
              ? { ...mismatched, key: "npm" }
              : name === "release_secret_set"
                ? { ...mismatched, name: "NPM_TOKEN", value: "z".repeat(8) }
                : name === "session_step_up_challenge"
                  ? { action: "release_pin_repo", input: { ...mismatched, repo: "evil/x" } }
                  : mismatched;
      const r = await h.call(name, input);
      expect(r.ok, name).toBe(false);
      // not found for the pair, whatever else is missing: the step-up is not even looked at
      if (!r.ok) expect(["not_found", "forbidden"], name).toContain(r.error.code);
    }
    // and a signed call that does name A's own project is untouched by any of it
    expect(attest.pinnedRepo(b.orgId, bOnly.id)).toBeUndefined();
    expect(attest.publishTargets(b.orgId, bOnly.id)).toEqual({});
    expect(attest.configVersion()).toBe(0);
  });

  test("the lane itself refuses a message that pairs one org with another org's project", async () => {
    const r = await h.client!.call("pin_repo", {
      orgId: a.orgId,
      projectId: b.projectId,
      repo: "evil/x",
    });
    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect(attest.pinnedRepo(a.orgId, b.projectId)).toBeUndefined();
    expect(attest.pinnedRepo(b.orgId, b.projectId)).toBeUndefined();
    expect(attest.configVersion()).toBe(0);
  });

  test("a step-up from org A's approver cannot be used for org B's project", async () => {
    // same slugs for the project in both orgs; the step-up is for A
    const su = await h.stepUpFor("release_pin_repo", PIN(a));
    const r = await h.call("release_pin_repo", PIN(b), su);
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(attest.pinnedRepo(b.orgId, b.projectId)).toBeUndefined();
  });
});

describe("the config channel is its own door", () => {
  test("a message under the worker's request key, a replay and a forged MAC are all refused", async () => {
    const { controlPost } = await import("@turntable/net");
    const { channelMac, configFields } = await import("../src/release/channel");
    const args = { orgId: a.orgId, projectId: a.projectId, repo: "evil/x" };
    const ts = Date.now();
    // the worker's key (or any other) is not the config key
    const wrong = await controlPost({ unix: h.sock }, "/v1/config", {
      action: "pin_repo",
      args,
      ts,
      mac: channelMac(
        randomBytes(32).toString("hex"),
        "config",
        configFields("pin_repo", args),
        ts,
      ),
    });
    expect(wrong.status).toBe(401);
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBeUndefined();
    // the right key works once; the same message again is a replay
    const good = {
      action: "pin_repo",
      args,
      ts,
      mac: channelMac(h.configKey, "config", configFields("pin_repo", args), ts),
    };
    expect((await controlPost({ unix: h.sock }, "/v1/config", good)).status).toBe(200);
    const replay = await controlPost({ unix: h.sock }, "/v1/config", good);
    expect(replay.status).toBe(401);
    expect(replay.json).toMatchObject({ reason: "replay" });
    // a MAC over other arguments does not authorize these
    const forged = await controlPost({ unix: h.sock }, "/v1/config", {
      ...good,
      args: { ...args, repo: "evil/y" },
      ts: ts + 1,
    });
    expect(forged.status).toBe(401);
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBe("evil/x");
  });
});
