// The release lane page's pieces (#541): who sees it, the step-up flow every write runs first, the
// write-only secret form, and the wire shapes. No DOM: the flow takes injected API and signer.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TurntableApi } from "../src/api/client";
import { createFixture } from "../src/api/fixture/adapter";
import { createHttpApi } from "../src/api/http-adapter";
import type { LaneAction, StepUpChallenge, StepUpProof } from "../src/api/types";
import { SecretFormView, KeyView } from "../src/features/settings/release-lane-page";
import {
  canConfigureLane,
  cosignKeyInput,
  fingerprintOf,
  listOf,
  runLaneWrite,
  secretDigest,
  signingInput,
  targetInput,
} from "../src/lib/release-lane";

const MARKER = "hunter2-marker";
const sig = {
  kind: "webauthn" as const,
  credential_id: "cred",
  client_data_json: "cdj",
  authenticator_data: "ad",
  signature: "sg",
};
const challenge: StepUpChallenge = {
  id: "step-up-id-0123456789",
  challenge: "chal",
  rpId: "ci.example.test",
  passkeys: [{ approver: "ap1", passkeyId: "pk1" }],
};

function fakeApi(over: { passkeys?: StepUpChallenge["passkeys"]; refuse?: string } = {}) {
  const log: { step: string; arg: unknown }[] = [];
  const api = {
    stepUpChallenge: async (a: unknown) => {
      log.push({ step: "challenge", arg: a });
      return { ...challenge, passkeys: over.passkeys ?? challenge.passkeys };
    },
    laneWrite: async (a: { action: LaneAction; input: unknown; stepUp: StepUpProof }) => {
      log.push({ step: "write", arg: a });
      if (over.refuse) throw new Error(over.refuse);
      return { ok: true };
    },
  } as unknown as TurntableApi;
  return { api, log };
}

describe("who sees the page", () => {
  test("only an owner of the operator org", () => {
    expect(canConfigureLane({ role: "owner", operatorOrg: true })).toBe(true);
    expect(canConfigureLane({ role: "owner", operatorOrg: false })).toBe(false);
    for (const role of ["admin", "member", "viewer", "operator", "reader"]) {
      expect(canConfigureLane({ role, operatorOrg: true })).toBe(false);
    }
    expect(canConfigureLane(undefined)).toBe(false);
  });

  test("the fixture says whether its org is the operator org", async () => {
    expect((await createFixture({ operatorOrg: false }).api.whoami()).operatorOrg).toBe(false);
    expect((await createFixture({}).api.whoami()).operatorOrg).toBe(true);
  });
});

describe("the step-up runs first, for exactly this input", () => {
  test("challenge, then the passkey, then the write with the assertion", async () => {
    const { api, log } = fakeApi();
    const signed: unknown[] = [];
    const input = { target_org: "acme", target_project: "web", repo: "acme/web" };
    await runLaneWrite(
      api,
      async (o) => {
        signed.push(o);
        return sig;
      },
      "release_pin_repo",
      input,
    );
    expect(log.map((l) => l.step)).toEqual(["challenge", "write"]);
    expect(log[0]!.arg).toEqual({ action: "release_pin_repo", input });
    expect(signed).toEqual([{ challenge: "chal", rpId: "ci.example.test", passkeyId: "pk1" }]);
    expect(log[1]!.arg).toMatchObject({
      action: "release_pin_repo",
      input,
      stepUp: { id: challenge.id, approver: "ap1", signature: { credential_id: "cred" } },
    });
  });

  test("no passkey, or a cancelled ceremony: nothing is written", async () => {
    const none = fakeApi({ passkeys: [] });
    await expect(
      runLaneWrite(none.api, async () => sig, "release_pin_repo", { repo: "a/b" }),
    ).rejects.toThrow("No passkey");
    expect(none.log.map((l) => l.step)).toEqual(["challenge"]);
    const cancelled = fakeApi();
    await expect(
      runLaneWrite(
        cancelled.api,
        async () => {
          throw new Error("cancelled");
        },
        "release_pin_repo",
        { repo: "a/b" },
      ),
    ).rejects.toThrow("cancelled");
    expect(cancelled.log.map((l) => l.step)).toEqual(["challenge"]);
  });

  test("the server's refusal reaches the person", async () => {
    const { api } = fakeApi({ refuse: "release_pin_repo needs a fresh passkey step-up" });
    await expect(
      runLaneWrite(api, async () => sig, "release_pin_repo", { repo: "a/b" }),
    ).rejects.toThrow("step-up");
  });

  test("a secret value never goes into the challenge: its digest does", async () => {
    const { api, log } = fakeApi();
    const input = { target_org: "acme", target_project: "web", name: "NPM_TOKEN", value: MARKER };
    await runLaneWrite(api, async () => sig, "release_secret_set", input);
    const asked = JSON.stringify(log[0]!.arg);
    expect(asked).not.toContain(MARKER);
    expect(log[0]!.arg).toMatchObject({
      input: { value_sha256: await secretDigest("value", MARKER) },
    });
    // the write itself carries the value (that is its job), once
    expect(JSON.stringify(log[1]!.arg)).toContain(MARKER);
  });

  test("the digest matches the server's (a fixed vector from the core implementation)", async () => {
    expect(await secretDigest("value", MARKER)).toBe(
      "c1f0d5016848d8ebb8c58dd38ce01af144f0b0ed80ae882ff392dcbf6d6b161b",
    );
  });
});

describe("form helpers", () => {
  test("fingerprint, lists and the inputs the ops take", () => {
    expect(fingerprintOf("abcd01")).toBe("AB:CD:01");
    expect(listOf(" a, b\n\nc ")).toEqual(["a", "b", "c"]);
    expect(
      signingInput({
        targetOrg: " acme ",
        targetProject: "web",
        signingKey: "builtin:release",
        environment: "",
        refs: "refs/tags/v*, refs/heads/rel",
      }),
    ).toEqual({
      target_org: "acme",
      target_project: "web",
      signing_key: "builtin:release",
      release_refs: ["refs/tags/v*", "refs/heads/rel"],
    });
    expect(
      targetInput({
        targetOrg: "acme",
        targetProject: "web",
        key: "npm",
        kind: "npm",
        fields: { package: "@acme/web", artifact: "web.tgz", secret: "NPM_TOKEN", assets: "x" },
        acceptLongLived: true,
      }),
    ).toEqual({
      target_org: "acme",
      target_project: "web",
      key: "npm",
      kind: "npm",
      package: "@acme/web",
      artifact: "web.tgz",
      secret: "NPM_TOKEN",
      accept_long_lived_token: true,
    });
  });
});

describe("co-signing keys", () => {
  test("the form's input is exactly what the op takes, public key only", () => {
    expect(
      cosignKeyInput({
        targetOrg: " acme ",
        targetProject: "web",
        name: "pinned",
        publicKeyPem: " PEM ",
        signs: "manifest.json",
        outputName: "manifest.json.sig",
        manifestBinaries: true,
      }),
    ).toEqual({
      target_org: "acme",
      target_project: "web",
      name: "pinned",
      public_key_pem: "PEM",
      signs: "manifest.json",
      output_name: "manifest.json.sig",
      format: "detached-der-p256-sha256",
      manifest_binaries: true,
    });
  });

  test("the github-release form carries asset_artifacts", () => {
    expect(
      targetInput({
        targetOrg: "acme",
        targetProject: "web",
        key: "gh",
        kind: "github-release",
        fields: { asset_artifacts: "release-binaries, other" },
        acceptLongLived: false,
      }),
    ).toMatchObject({ asset_artifacts: ["release-binaries", "other"] });
  });
});

describe("the write-only secret form", () => {
  const view = (over: Partial<Parameters<typeof SecretFormView>[0]> = {}) =>
    renderToStaticMarkup(
      <SecretFormView
        org="acme"
        project="web"
        name="NPM_TOKEN"
        value=""
        status={null}
        busy={false}
        error={null}
        notice={null}
        onOrg={() => {}}
        onProject={() => {}}
        onName={() => {}}
        onValue={() => {}}
        onStatus={() => {}}
        onSubmit={() => {}}
        {...over}
      />,
    );

  test("the value field is a password field that is never prefilled", () => {
    const html = view();
    expect(html).toContain('type="password"');
    expect(html).not.toContain(MARKER);
  });

  test("the status shows when and by whom, and nothing of the value", () => {
    const html = view({
      status: { set: true, setAt: "2026-11-25T10:00:00.000Z", setBy: "alice" },
      notice: "Stored NPM_TOKEN (lane config version 3).",
    });
    expect(html).toContain("Set at 2026-11-25T10:00:00.000Z by alice.");
    expect(html).not.toContain(MARKER);
    expect(view({ status: { set: false, setAt: null, setBy: null } })).toContain("Not set.");
  });

  test("a key shows its public key, id and fingerprint, and no private material", () => {
    const html = renderToStaticMarkup(
      <KeyView
        k={{
          keyid: "ab".repeat(32),
          publicKeyPem: "-----BEGIN PUBLIC KEY-----\nxx\n-----END PUBLIC KEY-----\n",
          createdAt: "2026-11-25T10:00:00.000Z",
        }}
      />,
    );
    expect(html).toContain("AB:AB:AB");
    expect(html).toContain("BEGIN PUBLIC KEY");
    expect(html).not.toContain("PRIVATE");
  });
});

describe("the wire", () => {
  function make(handler: (url: URL, init: RequestInit) => Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const api = createHttpApi({
      token: () => null,
      session: () => true,
      org: () => "local",
      baseUrl: "https://ci.example.test",
      fetch: (async (u: string, init: RequestInit) => {
        const url = new URL(u);
        calls.push({ url, init });
        return handler(url, init);
      }) as unknown as typeof fetch,
    } as unknown as Parameters<typeof createHttpApi>[0]);
    return { api, calls };
  }
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

  test("a write posts the input with the step-up and the operator org", async () => {
    const { api, calls } = make(() => json({ repo: "acme/web", config_version: 1 }));
    const stepUp: StepUpProof = { id: "i".repeat(20), approver: "a", signature: { ...sig } };
    await api.laneWrite({
      action: "release_pin_repo",
      input: { target_org: "acme", target_project: "web", repo: "acme/web" },
      stepUp,
    });
    expect(calls[0]!.url.pathname).toBe("/api/v1/release-lane/pin-repo");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      org: "local",
      target_org: "acme",
      target_project: "web",
      repo: "acme/web",
      step_up: stepUp,
    });
  });

  test("reads map to the page's shapes, and the status carries no value", async () => {
    const { api, calls } = make((url) =>
      url.pathname.endsWith("/secrets")
        ? json({ set: true, set_at: "t", set_by: "alice" })
        : json({
            pinned_repo: "acme/web",
            config_version: 2,
            targets: [
              { key: "npm", kind: "npm", mode: "strict", has_credential: true, settings: {} },
            ],
          }),
    );
    expect(
      await api.laneSecretStatus({ targetOrg: "acme", targetProject: "web", name: "NPM_TOKEN" }),
    ).toEqual({ set: true, setAt: "t", setBy: "alice" });
    expect(calls[0]!.url.searchParams.get("org")).toBe("local");
    expect(calls[0]!.url.searchParams.get("target_project")).toBe("web");
    const cfg = await api.laneConfig({ targetOrg: "acme", targetProject: "web" });
    expect(cfg.targets[0]).toMatchObject({ key: "npm", hasCredential: true });
  });

  test("the co-signing keys read maps to fingerprints only, and a write posts to its path", async () => {
    const { api, calls } = make((url) =>
      url.pathname.endsWith("/cosign-keys")
        ? json({
            config_version: 4,
            keys: [
              {
                name: "pinned",
                key_id: "0123456789abcdef",
                spki_sha256: "f".repeat(64),
                signs: "manifest.json",
                output_name: "manifest.json.sig",
                format: "detached-der-p256-sha256",
                manifest: true,
              },
            ],
          })
        : json({}),
    );
    const r = await api.laneCosignKeys({ targetOrg: "acme", targetProject: "web" });
    expect(r.configVersion).toBe(4);
    expect(r.keys[0]).toMatchObject({ name: "pinned", keyId: "0123456789abcdef", manifest: true });
    expect(JSON.stringify(r)).not.toContain("PUBLIC KEY");
    await api.laneWrite({
      action: "release_cosign_key_remove",
      input: { target_org: "acme", target_project: "web", name: "pinned" },
      stepUp: { id: "i".repeat(20), approver: "a", signature: { ...sig } },
    });
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/release-lane/cosign-keys/delete");
  });

  test("whoami carries operator_org", async () => {
    const { api } = make(() =>
      json({
        kind: "member",
        id: "m",
        name: null,
        role: "owner",
        org: "local",
        project: null,
        expires_at: null,
        operator_org: true,
      }),
    );
    expect((await api.whoami()).operatorOrg).toBe(true);
  });
});
