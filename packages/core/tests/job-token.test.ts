import { describe, expect, test } from "bun:test";
import { AppAuth } from "../src/github/app-auth";
import {
  capPermissions,
  type IssueRequest,
  type IssuedJobToken,
  JobTokens,
  publicRepoCheck,
} from "../src/github/job-token";
import { setup } from "./github-helpers";

describe("capPermissions", () => {
  test("untrusted_pr: contents read, whatever was asked, and a note", () => {
    const r = capPermissions(
      { contents: "write", issues: "write", pull_requests: "read" },
      "untrusted_pr",
    );
    expect(r.permissions).toEqual({ metadata: "read", contents: "read" });
    expect(r.notes.join(" ")).toContain("untrusted pull request");
    // Even nothing asked for gets contents read: that is the floor for a PR.
    expect(capPermissions({}, "untrusted_pr").permissions).toEqual({
      metadata: "read",
      contents: "read",
    });
  });

  test("trusted_pr: what was asked for, never write", () => {
    const r = capPermissions({ contents: "write", issues: "read" }, "trusted_pr");
    expect(r.permissions).toEqual({ metadata: "read", contents: "read", issues: "read" });
    expect(r.notes.join(" ")).toContain("contents: write lowered to read");
  });

  test("protected and release get what they asked for", () => {
    for (const k of ["protected", "release"] as const) {
      expect(capPermissions({ contents: "write", packages: "write" }, k).permissions).toEqual({
        metadata: "read",
        contents: "write",
        packages: "write",
      });
    }
  });

  test("never more than the installation was granted", () => {
    const r = capPermissions({ contents: "write", issues: "write", packages: "read" }, "release", {
      contents: "read",
      issues: "write",
    });
    expect(r.permissions).toEqual({ metadata: "read", contents: "read", issues: "write" });
    expect(r.notes.join(" ")).toContain("packages: the App installation was not granted it");
    expect(r.notes.join(" ")).toContain("contents: the App installation has read only");
  });

  test("id-token is never in the result", () => {
    const r = capPermissions({ id_token: "write" } as never, "release");
    expect(Object.keys(r.permissions)).not.toContain("id_token");
  });
});

/** A fake GitHub: installations with grants, tokens that live until revoked. */
function fakeGithub(granted: Record<string, string>) {
  const calls: { method: string; path: string; body: unknown; bearer: string }[] = [];
  const live = new Map<string, { repos: string[]; permissions: Record<string, string> }>();
  let n = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const bearer = String((init?.headers as Record<string, string>)?.authorization ?? "").replace(
      "Bearer ",
      "",
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, bearer });
    if (method === "POST" && /\/app\/installations\/[^/]+\/access_tokens$/.test(u.pathname)) {
      const b = body as { repositories?: string[]; permissions?: Record<string, string> };
      for (const [k, v] of Object.entries(b.permissions ?? {})) {
        const have = granted[k];
        if (!have || (v === "write" && have === "read")) {
          return Response.json({ message: "permissions exceed the grant" }, { status: 422 });
        }
      }
      const token = ["ghs", "fake", ++n].join("_");
      live.set(token, { repos: b.repositories ?? [], permissions: b.permissions ?? {} });
      return Response.json(
        { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    }
    if (method === "GET" && /\/app\/installations\/[^/]+$/.test(u.pathname)) {
      return Response.json({ permissions: granted });
    }
    if (method === "DELETE" && u.pathname === "/installation/token") {
      return live.delete(bearer)
        ? new Response(null, { status: 204 })
        : new Response("", { status: 401 });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls, live };
}

async function mint(t: JobTokens, r: IssueRequest): Promise<IssuedJobToken> {
  const out = await t.issue(r);
  if ("none" in out) throw new Error(`no token minted: ${out.none}`);
  return out;
}

describe("job tokens against a fake GitHub", () => {
  async function issuer(granted: Record<string, string>) {
    const { db, store } = await setup();
    const g = fakeGithub(granted);
    const auth = new AppAuth({ db, store, fetch: g.impl });
    return { g, tokens: new JobTokens(auth), auth };
  }
  const yaml = (perm: string): string =>
    `name: t\non: push\njobs:\n  build:\n    runs-on: x\n${perm}    steps: []\n`;

  test("one repository, the declared permissions, minted fresh for each job and never shared", async () => {
    const { g, tokens } = await issuer({ metadata: "read", contents: "write", issues: "write" });
    const req = {
      installationId: "100",
      owner: "acme",
      repo: "app",
      klass: "release" as const,
      workflowYaml: yaml("    permissions:\n      contents: write\n      issues: read\n"),
      jobId: "build",
    };
    const a = await mint(tokens, req);
    const b = await mint(tokens, req);
    expect(a.token).not.toBe(b.token);
    const mints = g.calls.filter((c) => c.method === "POST");
    expect(mints).toHaveLength(2);
    expect(mints[0]?.body).toEqual({
      repositories: ["app"],
      permissions: { metadata: "read", contents: "write", issues: "read" },
    });
    expect(a.permissions).toEqual({ metadata: "read", contents: "write", issues: "read" });
  });

  test("a scope beyond contents read is minted as declared", async () => {
    const { g, tokens } = await issuer({ metadata: "read", contents: "write", issues: "write" });
    await mint(tokens, {
      installationId: "100",
      owner: "acme",
      repo: "app",
      klass: "protected",
      workflowYaml: yaml("    permissions:\n      issues: read\n"),
      jobId: "build",
    });
    expect(g.calls.find((c) => c.method === "POST")?.body).toEqual({
      repositories: ["app"],
      permissions: { metadata: "read", issues: "read" },
    });
  });

  test("a request wider than the installation's grant is lowered before it is sent", async () => {
    const { g, tokens } = await issuer({ metadata: "read", contents: "read", issues: "read" });
    const t = await mint(tokens, {
      installationId: "100",
      owner: "acme",
      repo: "app",
      klass: "release",
      workflowYaml: yaml("    permissions: write-all\n"),
      jobId: "build",
    });
    expect(t.permissions).toEqual({ metadata: "read", contents: "read", issues: "read" });
    expect(t.notes.join(" ")).toContain("not granted");
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("untrusted_pr: contents read only, so no token, even if the workflow asks for write-all", async () => {
    const { g, tokens } = await issuer({ metadata: "read", contents: "write", issues: "write" });
    const r = await tokens.issue({
      installationId: "100",
      owner: "acme",
      repo: "app",
      klass: "untrusted_pr",
      workflowYaml: yaml("    permissions: write-all\n"),
      jobId: "build",
    });
    expect("none" in r).toBe(true);
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("revoke deletes exactly that token at GitHub, once, and the token stops working", async () => {
    const { g, tokens } = await issuer({ metadata: "read", contents: "read", issues: "read" });
    const req = {
      installationId: "100",
      owner: "acme",
      repo: "app",
      klass: "protected" as const,
      workflowYaml: yaml("    permissions:\n      issues: read\n"),
      jobId: "build",
    };
    const a = await mint(tokens, req);
    const b = await mint(tokens, req);
    expect(g.live.has(a.token)).toBe(true);
    await a.revoke();
    await a.revoke();
    expect(g.live.has(a.token)).toBe(false);
    // The other job's token is untouched.
    expect(g.live.has(b.token)).toBe(true);
    const deletes = g.calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.bearer).toBe(a.token);
    expect(deletes[0]?.path).toBe("/installation/token");
  });

  test("a failing revoke never throws", async () => {
    const { db, store } = await setup();
    const bad = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const auth = new AppAuth({ db, store, fetch: bad });
    await expect(auth.revoke(["ghs", "whatever"].join("_"))).resolves.toBe(false);
  });
});

describe("a token only when it is needed", () => {
  const yaml = (perm: string): string =>
    `name: t\non: push\njobs:\n  build:\n    runs-on: x\n${perm}    steps: []\n`;
  const req = (klass: "untrusted_pr" | "trusted_pr" | "protected" | "release", perm = "") => ({
    installationId: "100",
    owner: "acme",
    repo: "app",
    klass,
    workflowYaml: yaml(perm),
    jobId: "build",
  });
  async function make(isPublic: ((o: string, r: string) => Promise<boolean>) | undefined) {
    const { db, store } = await setup();
    const g = fakeGithub({
      metadata: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
    });
    const tokens = new JobTokens(new AppAuth({ db, store, fetch: g.impl }), { isPublic });
    return { g, tokens };
  }
  const minted = (g: { calls: { method: string }[] }): number =>
    g.calls.filter((c) => c.method === "POST").length;

  test("a public repo whose job needs only contents read gets no token, whatever the class", async () => {
    for (const klass of ["untrusted_pr", "trusted_pr", "protected", "release"] as const) {
      const { g, tokens } = await make(async () => true);
      const r = await tokens.issue(req(klass));
      expect("none" in r && r.none).toContain("is public");
      expect(minted(g)).toBe(0);
    }
  });

  test("a write scope needs a token even on a public repo (a PR class is capped to read, so it needs none)", async () => {
    const write = await make(async () => true);
    expect(
      "none" in
        (await write.tokens.issue(req("release", "    permissions:\n      issues: write\n"))),
    ).toBe(false);
    expect(minted(write.g)).toBe(1);
    // The same workflow for an untrusted PR is capped to contents read: nothing to mint.
    const pr = await make(async () => true);
    const r = await pr.tokens.issue(req("untrusted_pr", "    permissions: write-all\n"));
    expect("none" in r).toBe(true);
    expect(minted(pr.g)).toBe(0);
  });

  test("a read beyond contents needs a token", async () => {
    const { g, tokens } = await make(async () => true);
    const r = await tokens.issue(req("protected", "    permissions:\n      issues: read\n"));
    expect("none" in r).toBe(false);
    expect(minted(g)).toBe(1);
  });

  test("a private repo's job with only contents read gets no token: the controller delivers the tree", async () => {
    for (const klass of ["untrusted_pr", "trusted_pr", "protected", "release"] as const) {
      for (const perm of ["", "    permissions:\n      contents: read\n"]) {
        const { g, tokens } = await make(async () => false);
        const r = await tokens.issue(req(klass, perm));
        expect("none" in r && r.none).toContain("tree was delivered by Turntable");
        expect(minted(g)).toBe(0);
      }
    }
  });

  test("a private repo's job with a write scope still gets a token", async () => {
    for (const scope of ["contents: write", "issues: write", "pull-requests: write"]) {
      const { g, tokens } = await make(async () => false);
      const r = await tokens.issue(req("protected", `    permissions:\n      ${scope}\n`));
      expect("none" in r).toBe(false);
      expect(minted(g)).toBe(1);
    }
  });

  test("a checkout of another repository or with submodules keeps the token rule and names the need", async () => {
    const co = (w: string): string =>
      `    steps:\n      - uses: actions/checkout@v4\n        with:\n${w}`;
    const cases: [string, string][] = [
      ["          repository: acme/other\n", "another repository (acme/other)"],
      ["          submodules: recursive\n", "submodules"],
    ];
    for (const [w, need] of cases) {
      const { g, tokens } = await make(async () => false);
      const r = await tokens.issue({
        ...req("protected"),
        workflowYaml: `name: t\non: push\njobs:\n  build:\n    runs-on: x\n${co(w)}`,
      });
      expect("none" in r).toBe(false);
      expect(!("none" in r) && r.needs.join(" ")).toContain(need);
      expect(minted(g)).toBe(1);
    }
    // The same repository by name is the delivered tree: no token.
    const { g, tokens } = await make(async () => false);
    const r = await tokens.issue({
      ...req("protected"),
      workflowYaml: `name: t\non: push\njobs:\n  build:\n    runs-on: x\n${co("          repository: Acme/App\n")}`,
    });
    expect("none" in r).toBe(true);
    expect(minted(g)).toBe(0);
  });

  test("a write scope names itself in needs", async () => {
    const { tokens } = await make(async () => false);
    const r = await tokens.issue(req("protected", "    permissions:\n      issues: write\n"));
    expect(!("none" in r) && r.needs).toEqual(["issues: write"]);
  });

  test("when visibility is unknown, or the check fails, a read-only job still gets no token", async () => {
    for (const isPublic of [
      undefined,
      async (): Promise<boolean> => {
        throw new Error("rate limited");
      },
    ]) {
      const { g, tokens } = await make(isPublic);
      expect("none" in (await tokens.issue(req("protected")))).toBe(true);
      expect(minted(g)).toBe(0);
    }
  });
});

describe("publicRepoCheck: asked as the App, not anonymously", () => {
  const TOKEN = ["ghs", "visibility", "check"].join("_");
  function app(mintFails = false) {
    const mints: unknown[] = [];
    return {
      mints,
      auth: {
        apiBase: "https://api.github.test",
        mint: async (id: string, scope: unknown) => {
          if (mintFails) throw new Error("mint failed");
          mints.push({ id, scope });
          return { token: TOKEN };
        },
      },
    };
  }
  const json = (status: number, body: unknown, seen: { url: string; auth: string }[] = []) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: String((init?.headers as Record<string, string>)?.authorization),
      });
      return Response.json(body, { status });
    }) as unknown as typeof fetch;

  test("uses a read-only token for that repository and sends it: never an anonymous request", async () => {
    const a = app();
    const seen: { url: string; auth: string }[] = [];
    const check = publicRepoCheck({ auth: a.auth, fetch: json(200, { private: false }, seen) });
    expect(await check("acme", "app", "100")).toBe(true);
    expect(a.mints).toEqual([
      { id: "100", scope: { repositories: ["app"], permissions: { contents: "read" } } },
    ]);
    expect(seen).toEqual([
      { url: "https://api.github.test/repos/acme/app", auth: `Bearer ${TOKEN}` },
    ]);
  });

  test("a public repo is public; a private one, an error, a rate limit and a failed mint are not", async () => {
    const pub = (body: unknown, status = 200) =>
      publicRepoCheck({ auth: app().auth, fetch: json(status, body) });
    expect(await pub({ private: false })("acme", "app", "1")).toBe(true);
    expect(await pub({ private: true })("acme", "app", "1")).toBe(false);
    expect(await pub({}, 404)("acme", "app", "1")).toBe(false);
    expect(await pub({}, 403)("acme", "app", "1")).toBe(false);
    expect(await pub({})("acme", "app", "1")).toBe(false);
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await publicRepoCheck({ auth: app().auth, fetch: down })("acme", "app", "1")).toBe(
      false,
    );
    const noMint = app(true);
    expect(
      await publicRepoCheck({ auth: noMint.auth, fetch: json(200, { private: false }) })(
        "acme",
        "app",
        "1",
      ),
    ).toBe(false);
  });

  test("a clear answer is remembered for a while, an error is asked again, a bad name never asks", async () => {
    let calls = 0;
    let status = 200;
    const f = (async () => {
      calls++;
      return Response.json({ private: false }, { status });
    }) as unknown as typeof fetch;
    let now = 1000;
    const a = app();
    const check = publicRepoCheck({ auth: a.auth, fetch: f, now: () => now, ttlMs: 60_000 });
    expect(await check("acme", "app", "1")).toBe(true);
    expect(await check("ACME", "App", "1")).toBe(true);
    expect(calls).toBe(1);
    now += 61_000;
    status = 403;
    expect(await check("acme", "app", "1")).toBe(false);
    expect(await check("acme", "app", "1")).toBe(false);
    expect(calls).toBe(3);
    expect(await check("../x", "app", "1")).toBe(false);
    expect(calls).toBe(3);
  });
});
