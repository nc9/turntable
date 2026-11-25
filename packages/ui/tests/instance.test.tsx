import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/api/http-adapter";
import { createInstanceApi } from "../src/api/instance";
import { RotatedNotice } from "../src/features/instance/rotated-notice";
import { InstanceSignIn } from "../src/features/instance/sign-in";
import { isInstancePath } from "../src/features/instance/instance-shell";
import { parseLimit } from "../src/features/instance/use-action";
import { getToken } from "../src/lib/auth";
import {
  clearRotated,
  completeRotation,
  connectInstance,
  disconnectInstance,
  getInstanceToken,
  INSTANCE_TOKEN_KEY,
} from "../src/lib/instance-auth";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TOKEN = ["tti", "unit-test-value"].join("_");

function make(handler: (url: URL, init: RequestInit) => Response, onUnauth?: () => void) {
  const calls: { url: URL; init: RequestInit; body: unknown }[] = [];
  const api = createInstanceApi({
    token: () => TOKEN,
    ...(onUnauth ? { onUnauthenticated: onUnauth } : {}),
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      calls.push({
        url,
        init,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return handler(url, init);
    }) as typeof fetch,
  });
  return { api, calls };
}

const quotas = {
  limits: {
    max_concurrent: 2,
    max_runs_per_hour: null,
    max_sandbox_minutes_per_day: null,
    max_log_bytes: null,
    max_stored_bytes: null,
  },
  usage: [],
};

describe("instance client", () => {
  test("every call is an /api/v1/instance route carrying only the instance token", async () => {
    const { api, calls } = make((url) => {
      if (url.pathname.endsWith("/whoami"))
        return json({ id: "i1", name: "ops", expires_at: null });
      if (url.pathname.endsWith("/orgs")) return json({ orgs: [{ slug: "acme", name: "Acme" }] });
      if (url.pathname.endsWith("/settings")) return json({ settings: [] });
      if (url.pathname.endsWith("/quotas")) return json(quotas);
      return json({});
    });
    await api.whoami();
    await api.listOrgs();
    await api.listSettings();
    await api.setQuotas({ org: "acme", patch: { maxConcurrent: 2 } });
    for (const c of calls) {
      expect(c.url.pathname.startsWith("/api/v1/instance/")).toBe(true);
      expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url.searchParams.has("org")).toBe(false);
    }
  });

  test("set_quotas names only the limits to change, and null removes one", async () => {
    const { api, calls } = make(() => json(quotas));
    const out = await api.setQuotas({
      org: "acme",
      patch: { maxConcurrent: 2, maxLogBytes: null },
    });
    expect(calls[0]!.url.pathname).toBe("/api/v1/instance/quotas");
    expect(calls[0]!.body).toEqual({ target_org: "acme", max_concurrent: 2, max_log_bytes: null });
    expect(out.limits.maxConcurrent).toBe(2);
  });

  test("instance settings keep their instance scope and go to /instance/settings", async () => {
    const { api, calls } = make(() =>
      json({
        settings: [
          {
            key: "backup_keep",
            scope: "instance",
            description: "d",
            value: 10,
            default: 10,
            source: "env",
            locked: true,
            locked_by: "TURNTABLE_BACKUP_KEEP",
            role: "admin",
            mcp_editable: false,
          },
        ],
      }),
    );
    const [s] = await api.listSettings();
    expect(s).toMatchObject({ scope: "instance", source: "env", locked: true });
    await api.setSetting({ key: "backup_keep", value: 5 });
    await api.setSetting({ key: "backup_keep", unset: true });
    expect(calls[1]!.body).toEqual({ key: "backup_keep", value: 5 });
    expect(calls[2]!.body).toEqual({ key: "backup_keep", unset: true });
  });

  test("create_project and set_project_settings send the target org and project", async () => {
    const { api, calls } = make((url) =>
      url.pathname.endsWith("/projects")
        ? json({ org: "acme", project: "web", id: "p1", name: "Web" })
        : json({
            project: "p1",
            sandbox_snapshot: "snap-1",
            max_concurrent: null,
            untrusted_run_approval: "no_agents",
          }),
    );
    await api.createProject({ org: "acme", slug: "web", name: "Web" });
    const s = await api.setProjectSettings({
      org: "acme",
      project: "web",
      patch: { sandboxSnapshot: "snap-1" },
    });
    expect(calls[0]!.body).toEqual({ target_org: "acme", slug: "web", name: "Web" });
    expect(calls[1]!.url.pathname).toBe("/api/v1/instance/project-settings");
    expect(calls[1]!.body).toEqual({
      target_org: "acme",
      target_project: "web",
      sandbox_snapshot: "snap-1",
    });
    expect(s.sandboxSnapshot).toBe("snap-1");
  });

  test("db_backup returns the path, size and sha256 and nothing else", async () => {
    const { api, calls } = make(() =>
      json({
        path: "/data/backups/b.db",
        name: "b.db",
        size_bytes: 4096,
        sha256: "ab".repeat(32),
        version: "0.0.0",
        created_at: "2026-01-01T00:00:00.000Z",
        pruned: ["old.db"],
      }),
    );
    const r = await api.dbBackup();
    expect(Object.keys(r).sort()).toEqual(["path", "sha256", "sizeBytes"]);
    expect(r.sizeBytes).toBe(4096);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/api/v1/instance/db-backup");
  });

  test("a refusal is thrown with the server's words, unchanged", async () => {
    const msg = "max_concurrent 9 is above the instance's per-org cap of 4; it can only lower it";
    const { api } = make(() => json({ error: { code: "invalid_input", message: msg } }, 400));
    const err = await api.setQuotas({ org: "acme", patch: { maxConcurrent: 9 } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(msg);
  });

  test("a 401 reports the token as not accepted", async () => {
    let n = 0;
    const { api } = make(
      () => json({ error: { code: "unauthenticated", message: "no" } }, 401),
      () => n++,
    );
    await api.whoami().catch(() => {});
    expect(n).toBe(1);
  });

  test("rotation returns the new secret and the revoked id", async () => {
    const { api, calls } = make(() =>
      json({
        id: "i2",
        secret: "new-secret",
        expires_at: "2026-02-01T00:00:00.000Z",
        revoked_id: "i1",
      }),
    );
    const r = await api.rotateToken();
    expect(r).toMatchObject({ id: "i2", secret: "new-secret", revokedId: "i1" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/instance/tokens/rotate");
  });

  test("without a token nothing is sent", async () => {
    let sent = 0;
    const api = createInstanceApi({
      token: () => null,
      fetch: (async (_u: RequestInfo | URL) => {
        sent++;
        return json({});
      }) as typeof fetch,
    });
    await expect(api.whoami()).rejects.toBeInstanceOf(ApiError);
    expect(sent).toBe(0);
  });
});

describe("separate sign-in", () => {
  test("the instance token is kept apart from the org session", () => {
    connectInstance(TOKEN);
    expect(getInstanceToken()).toBe(TOKEN);
    expect(getToken()).not.toBe(TOKEN);
    expect(INSTANCE_TOKEN_KEY).not.toBe("tt-token");
    disconnectInstance();
    expect(getInstanceToken()).toBeNull();
  });

  test("the org client, the realtime socket and the instance client never share a token source", () => {
    const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
    expect(src("../src/api/index.ts")).not.toContain("instance-auth");
    expect(src("../src/api/ws-adapter.ts")).not.toContain("instance-auth");
    expect(src("../src/api/http-adapter.ts")).not.toContain("instance-auth");
    expect(src("../src/api/instance.ts")).not.toContain("@/lib/auth");
    expect(src("../src/api/instance.ts")).not.toContain("/mcp");
    expect(src("../src/api/instance.ts")).not.toContain("realtime");
  });

  test("the instance area is its own path, apart from any org", () => {
    expect(isInstancePath("/-/instance")).toBe(true);
    expect(isInstancePath("/-/instance/backups")).toBe(true);
    expect(isInstancePath("/acme/-/instance")).toBe(false);
    expect(isInstancePath("/-/instancey")).toBe(false);
  });

  test("the sign-in says it is separate and takes a tti_ token", () => {
    const html = renderToStaticMarkup(<InstanceSignIn />);
    expect(html).toContain("Instance administrator");
    expect(html).toContain("separate sign-in");
    expect(html).toContain("tti_...");
    expect(html).toContain('type="password"');
  });
});

describe("rotation", () => {
  test("the new secret is shown with a copy button and the revocation warning", () => {
    const html = renderToStaticMarkup(<RotatedNotice secret="new-secret-value" />);
    expect(html).toContain("new-secret-value");
    expect(html).toContain("Copy");
    expect(html).toContain("only time the secret is shown");
    expect(html).toContain("old token is revoked");
    expect(html).toContain("sign in with the new one");
  });

  test("completing a rotation drops the revoked token and holds the secret in memory only", () => {
    connectInstance(TOKEN);
    completeRotation("new-secret-value");
    expect(getInstanceToken()).toBeNull();
    clearRotated();
  });
});

describe("limit fields", () => {
  test("blank leaves a limit alone, none removes it, a number sets it", () => {
    expect(parseLimit("")).toBeUndefined();
    expect(parseLimit("  ")).toBeUndefined();
    expect(parseLimit("none")).toBeNull();
    expect(parseLimit("12")).toBe(12);
    // Not a number: sent as typed so the server refuses it in its own words.
    expect(parseLimit("-3")).toBe("-3");
    expect(parseLimit("abc")).toBe("abc");
  });
});

describe("routes", () => {
  test("the instance paths match their own routes, not an org's project settings", async () => {
    const { router } = await import("../src/router");
    for (const name of ["settings", "quotas", "projects", "backups", "token"]) {
      const m = router.matchRoutes(`/-/instance/${name}`);
      expect(m.at(-1)!.routeId).toBe(`/-/instance/${name}`);
    }
  });
});

describe("instance App-secret calls", () => {
  test("a passkey step-up precedes the action, and only these calls carry the session cookie", async () => {
    const fakeCred = {
      rawId: new Uint8Array([1, 2, 3]).buffer,
      response: {
        clientDataJSON: new Uint8Array([4]).buffer,
        authenticatorData: new Uint8Array([5]).buffer,
        signature: new Uint8Array([6]).buffer,
      },
    };
    const prev = Object.getOwnPropertyDescriptor(navigator, "credentials");
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: async () => fakeCred, create: async () => null },
    });
    try {
      const pem = `key-${crypto.randomUUID()}`;
      const { api, calls } = make((url) => {
        if (url.pathname.endsWith("/step-up"))
          return json({
            step_up_id: "s".repeat(20),
            challenge: "AAAA",
            rp_id: "ci.example.test",
            passkeys: [{ approver: "ap1", passkey_id: "AQID" }],
          });
        if (url.pathname.endsWith("/private-key"))
          return json({ fingerprint: "SHA256:abc", app_id: "42" });
        return json({ id: "i1", name: "ops", expires_at: null });
      });
      const r = await api.replaceAppPrivateKey({ privateKey: pem });
      expect(r).toEqual({ fingerprint: "SHA256:abc", appId: "42" });
      expect(calls.map((c) => c.url.pathname)).toEqual([
        "/api/v1/instance/step-up",
        "/api/v1/instance/github-app/private-key",
      ]);
      expect(calls.every((c) => c.init.credentials === "same-origin")).toBe(true);
      const action = calls[1]!.body as { private_key: string; step_up: { id: string } };
      expect(action.private_key).toBe(pem);
      expect(action.step_up.id).toBe("s".repeat(20));
      await api.whoami();
      expect(calls[2]!.init.credentials).toBe("omit");
    } finally {
      if (prev) Object.defineProperty(navigator, "credentials", prev);
      else delete (navigator as unknown as Record<string, unknown>).credentials;
    }
  });
});
