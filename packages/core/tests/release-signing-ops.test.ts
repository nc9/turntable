// The project signing config over the instance ops (#541): `release_set_project_signing` writes the
// same project columns the CLI writes, behind a passkey step-up, and bumps the lane's config
// version; `release_project_signing` reads the effective values. A real lane and channel.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db";
import { getProjectSigning } from "../src/db/repos";
import { dispatch, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { setSigningPolicy } from "../src/ops/policy-cli";
import { AttestationStore } from "../src/release/attest";
import { fileKeyVault, type FileKeyVault } from "../src/release/key-vault";
import { opsHarness, type Harness } from "./release-config-helpers";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let attest: AttestationStore;
let dir: string;
let keys: FileKeyVault;
let h: Harness;

const SET = (t: Tenant, extra: Record<string, unknown> = {}) => ({
  target_org: t.slug,
  target_project: t.projectSlug,
  signing_key: "builtin:release",
  ...extra,
});

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  attest = new AttestationStore(":memory:");
  dir = mkdtempSync(join(tmpdir(), "tt-sign-"));
  keys = fileKeyVault(join(dir, "keys"), randomBytes(32));
  h = await opsHarness({ db, attest, orgId: a.orgId, keys });
});
afterEach(() => {
  h.dispose();
  attest.close();
  rmSync(dir, { recursive: true, force: true });
});

const read = async (token: string, transport: "rest" | "mcp" = "rest") =>
  dispatch(
    { ...h.env, allowInstance: false, transport },
    { kind: "bearer", token },
    "release_project_signing",
    {},
  );

describe("release_set_project_signing", () => {
  test("no step-up, a step-up for another op, or for other input: refused, nothing written", async () => {
    await h.signedCall("release_init_key", { target_org: a.slug, name: "release" });
    const v0 = attest.configVersion();
    const bare = await h.call("release_set_project_signing", SET(a));
    expect(!bare.ok && bare.error.code).toBe("forbidden");
    const pin = await h.stepUpFor("release_pin_repo", {
      target_org: a.slug,
      target_project: a.projectSlug,
      repo: "acme/web",
    });
    expect((await h.call("release_set_project_signing", SET(a), pin)).ok).toBe(false);
    const su = await h.stepUpFor(
      "release_set_project_signing",
      SET(a, { signing_environment: "x" }),
    );
    expect(
      (await h.call("release_set_project_signing", SET(a, { signing_environment: "y" }), su)).ok,
    ).toBe(false);
    expect((await getProjectSigning(db, a.scope)).signingKey).toBeNull();
    expect(attest.configVersion()).toBe(v0);
  });

  test("a key the lane does not hold for the org is refused with a reason; so is a bad value", async () => {
    const r = await h.signedCall("release_set_project_signing", SET(a));
    expect(!r.ok && r.error.code).toBe("invalid_input");
    expect(!r.ok && r.error.message).toContain("no such release key");
    const bad = await h.signedCall(
      "release_set_project_signing",
      SET(a, { signing_key: "nope:x" }),
    );
    expect(!bad.ok && bad.error.code).toBe("invalid_input");
    const refs = await h.signedCall("release_set_project_signing", {
      ...SET(a),
      release_refs: ["main"],
    });
    expect(refs.ok).toBe(false);
    expect((await getProjectSigning(db, a.scope)).signingKey).toBeNull();
  });

  test("a valid set changes the effective config, bumps the lane version, audits names only", async () => {
    const init = await h.signedCall("release_init_key", { target_org: a.slug, name: "release" });
    const keyid = init.ok ? (init.output as { keyid: string }).keyid : "";
    const reader = (await mintToken(db, a.scope, "reader")).secret;
    const before = await read(reader);
    expect(before.ok && before.output).toEqual({
      signing_key: null,
      keyid: null,
      signing_environment: "release",
      release_refs: ["refs/tags/v*"],
    });
    const v0 = attest.configVersion();
    const r = await h.signedCall(
      "release_set_project_signing",
      SET(a, { signing_environment: "prod", release_refs: ["refs/tags/r*"] }),
    );
    expect(r.ok).toBe(true);
    expect(attest.configVersion()).toBeGreaterThan(v0);
    expect(r.ok && (r.output as { config_version: number }).config_version).toBe(
      attest.configVersion(),
    );
    for (const transport of ["rest", "mcp"] as const) {
      const now = await read(reader, transport);
      expect(now.ok && now.output).toEqual({
        signing_key: "builtin:release",
        keyid,
        signing_environment: "prod",
        release_refs: ["refs/tags/r*"],
      });
    }
  });

  test("the CLI sees the op's write and the op sees the CLI's", async () => {
    await h.signedCall("release_init_key", { target_org: a.slug, name: "release" });
    await h.signedCall("release_set_project_signing", SET(a, { signing_environment: "prod" }));
    expect(await getProjectSigning(db, a.scope)).toMatchObject({
      signingKey: "builtin:release",
      environment: "prod",
    });
    await setSigningPolicy(db, a.slug, a.projectSlug, {
      signingKey: "aws-kms:alias/x",
      environment: "stage",
      releaseRefs: ["refs/heads/main"],
    });
    const reader = (await mintToken(db, a.scope, "reader")).secret;
    const r = await read(reader);
    expect(r.ok && r.output).toEqual({
      signing_key: "aws-kms:alias/x",
      keyid: null,
      signing_environment: "stage",
      release_refs: ["refs/heads/main"],
    });
  });

  test("it is not an MCP tool, and another org's project is not found", async () => {
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("release_set_project_signing");
    expect(registry.get("release_set_project_signing")!.mcp).toBe(false);
    const r = await h.call("instance_step_up_challenge", {
      action: "release_set_project_signing",
      input: { ...SET(a), target_project: "no-such-project" },
    });
    expect(!r.ok && r.error.code).toBe("not_found");
  });
});

describe("release_project_signing", () => {
  test("a reader reads it over REST and MCP; another org's reader sees only its own project", async () => {
    expect(mcpTools(registry).map((t) => t.name)).toContain("release_project_signing");
    const readerA = (await mintToken(db, a.scope, "reader")).secret;
    const readerB = (await mintToken(db, b.scope, "reader")).secret;
    await setSigningPolicy(db, a.slug, a.projectSlug, { environment: "only-a" });
    for (const transport of ["rest", "mcp"] as const) {
      const ra = await read(readerA, transport);
      expect(ra.ok && (ra.output as { signing_environment: string }).signing_environment).toBe(
        "only-a",
      );
      const rb = await read(readerB, transport);
      expect(rb.ok && (rb.output as { signing_environment: string }).signing_environment).toBe(
        "release",
      );
    }
    // naming org a from b's token is refused
    const named = await dispatch(
      { ...h.env, allowInstance: false, transport: "rest" },
      { kind: "bearer", token: readerB },
      "release_project_signing",
      { org: a.slug },
    );
    expect(named.ok).toBe(false);
  });
});
