import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, createHttpApi } from "../src/api/http-adapter";
import { PASSKEY_MESSAGE, refusalMessage, TOKEN_MESSAGE } from "../src/api/refusal";
import { ConnectScreen } from "../src/features/shell/connect";
import { SignInScreen } from "../src/features/shell/sign-in-screen";
import {
  csrfFromAuthPage,
  gateFor,
  getSession,
  loadSession,
  parseSession,
  pickOrg,
  resetSession,
  sanitizeNext,
  signOut,
  urlOrgSlug,
} from "../src/lib/session";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A browser-storage spy: session mode must write nothing to it.
const writes: string[] = [];
const spy = {
  getItem: () => null,
  setItem: (k: string) => void writes.push(k),
  removeItem: () => {},
};
beforeEach(() => {
  writes.length = 0;
  for (const k of ["sessionStorage", "localStorage"])
    Object.defineProperty(globalThis, k, { value: spy, configurable: true, writable: true });
  resetSession();
});
afterEach(() => resetSession());

const base = { fixture: false, hasToken: false, here: "/", path: "/" } as const;

describe("sign-in gate (the SPA routes a logged-out visit to /sign-in)", () => {
  test("logged-out start at / goes to the sign-in route, with no next", () => {
    expect(gateFor({ ...base, session: "anonymous" })).toEqual({
      kind: "redirect",
      to: "/sign-in",
    });
  });
  test("a deep link is kept as a same-origin next", () => {
    expect(
      gateFor({ ...base, session: "anonymous", path: "/acme/web", here: "/acme/web?branch=main" }),
    ).toEqual({ kind: "redirect", to: "/sign-in", next: "/acme/web?branch=main" });
  });
  test("waits while the session is unknown, then decides", () => {
    expect(gateFor({ ...base, session: "unknown" }).kind).toBe("wait");
  });
  test("the sign-in route shows the GitHub screen; /sign-in/token shows the token form", () => {
    expect(gateFor({ ...base, session: "anonymous", path: "/sign-in", here: "/sign-in" })).toEqual({
      kind: "screen",
      screen: "sign-in",
    });
    expect(
      gateFor({ ...base, session: "anonymous", path: "/sign-in/token", here: "/sign-in/token" }),
    ).toEqual({ kind: "screen", screen: "token" });
  });
  test("a signed-in visitor on the sign-in route goes on to a safe next, else home", () => {
    const at = { ...base, session: "signed-in", path: "/sign-in", here: "/sign-in" } as const;
    expect(gateFor({ ...at, next: "/acme/web" })).toEqual({ kind: "redirect", to: "/acme/web" });
    expect(gateFor({ ...at, next: "//evil.example" })).toEqual({ kind: "redirect", to: "/" });
    expect(gateFor({ ...at })).toEqual({ kind: "redirect", to: "/" });
  });
  test("a token or a session opens the app; the fixture never needs either", () => {
    expect(gateFor({ ...base, session: "anonymous", hasToken: true }).kind).toBe("app");
    expect(gateFor({ ...base, session: "signed-in" }).kind).toBe("app");
    expect(gateFor({ ...base, session: "anonymous", fixture: true }).kind).toBe("app");
    // a token that is rejected while on the token route leaves for next, not a loop
    expect(
      gateFor({ ...base, session: "unknown", hasToken: true, path: "/sign-in/token" }).kind,
    ).toBe("redirect");
  });
});

describe("next sanitising", () => {
  test("only same-origin relative paths survive", () => {
    expect(sanitizeNext("/acme/web/runs/1?x=1#y")).toBe("/acme/web/runs/1?x=1#y");
    for (const bad of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "acme",
      "/a\nb",
      "/sign-in",
      "/sign-in/token",
      "/",
      "",
      undefined,
      42,
    ])
      expect(sanitizeNext(bad)).toBeUndefined();
  });
});

describe("screens", () => {
  test("the GitHub button targets /auth/github/login and the token link /sign-in/token", () => {
    const html = renderToStaticMarkup(<SignInScreen />);
    expect(html).toContain('href="/auth/github/login"');
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain('href="/sign-in/token"');
    expect(html).toContain("Use an API token");
    // the token form is not on the landing page
    expect(html).not.toContain('type="password"');
  });
  test("the token route renders the token form", () => {
    const html = renderToStaticMarkup(<ConnectScreen />);
    expect(html).toContain('type="password"');
    expect(html).toContain('href="/sign-in"');
  });
});

describe("session", () => {
  test("parseSession keeps the orgs and treats anything odd as signed out", () => {
    const s = parseSession({
      signed_in: true,
      github_login: "octo",
      orgs: [{ slug: "acme", name: "Acme", role: "admin" }, { nope: 1 }, { slug: "b" }],
    });
    expect(s.status).toBe("signed-in");
    expect(s.login).toBe("octo");
    expect(s.orgs).toEqual([
      { slug: "acme", name: "Acme", role: "admin" },
      { slug: "b", name: "b", role: "" },
    ]);
    expect(parseSession({ signed_in: false }).status).toBe("anonymous");
    expect(parseSession(null).status).toBe("anonymous");
  });

  test("loadSession reads /auth/session with the same-origin cookie", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await loadSession(async (url: string, init: RequestInit = {}) => {
      seen.push({ url, init });
      return json({ signed_in: true, github_login: "octo", orgs: [{ slug: "acme", name: "A" }] });
    });
    expect(seen[0]?.url).toBe("/auth/session");
    expect(seen[0]?.init.credentials).toBe("same-origin");
    expect(getSession().status).toBe("signed-in");
    expect(writes).toEqual([]); // nothing stored in the browser
  });

  test("an unreachable server leaves the visitor signed out", async () => {
    await loadSession(async () => {
      throw new Error("down");
    });
    expect(getSession().status).toBe("anonymous");
  });
});

describe("org switcher logic", () => {
  const orgs = [{ slug: "acme" }, { slug: "beta" }];
  test("the URL org wins, then a valid remembered org, then the only org", () => {
    expect(pickOrg(orgs, { urlSlug: "beta", remembered: "acme" })).toBe("beta");
    expect(pickOrg(orgs, { urlSlug: null, remembered: "acme" })).toBe("acme");
    expect(pickOrg([{ slug: "solo" }], {})).toBe("solo");
  });
  test("a remembered or URL org the session does not list is ignored", () => {
    expect(pickOrg(orgs, { urlSlug: "gone", remembered: "gone" })).toBeNull();
    expect(pickOrg(orgs, { remembered: "gone" })).toBeNull();
    expect(pickOrg(orgs, { urlSlug: "gone", remembered: "beta" })).toBe("beta");
  });
  test("the org slug is the first path segment", () => {
    expect(urlOrgSlug("/acme/web/runs/1")).toBe("acme");
    expect(urlOrgSlug("/")).toBeNull();
    expect(urlOrgSlug("/-/instance/settings")).toBeNull();
  });
});

describe("session requests", () => {
  function make(handler: (url: URL, init: RequestInit) => Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const api = createHttpApi({
      org: () => "acme",
      token: () => null,
      session: () => true,
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input), "http://localhost");
        calls.push({ url, init });
        return handler(url, init);
      }) as unknown as typeof fetch,
    });
    return { api, calls };
  }
  const headerNames = (init: RequestInit): string[] =>
    Object.keys((init.headers ?? {}) as Record<string, string>).map((h) => h.toLowerCase());

  test("reads and writes carry the cookie and no bearer token, and store nothing", async () => {
    const { api, calls } = make((url) =>
      url.pathname.endsWith("/whoami")
        ? json({ kind: "member", id: "u", name: "octo", role: "admin", org: "acme" })
        : json({ error: { code: "internal", message: "x" } }, 500),
    );
    await api.whoami();
    await api.approveRun({ runId: "r", headSha: "a", workflowHash: "b" }).catch(() => {});
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.init.credentials).toBe("same-origin");
      expect(headerNames(c.init)).not.toContain("authorization");
    }
    expect(calls[0]?.url.searchParams.get("org")).toBe("acme");
    expect(calls[1]?.init.method).toBe("POST");
    expect(writes).toEqual([]);
  });

  test("a token request still sends the bearer token and omits cookies", async () => {
    const calls: RequestInit[] = [];
    const api = createHttpApi({
      org: () => "acme",
      token: () => "tt_unit",
      fetch: (async (_u: unknown, init: RequestInit) => {
        calls.push(init);
        return json({ orgs: [] });
      }) as unknown as typeof fetch,
    });
    await api.listOrgs();
    expect(calls[0]?.credentials).toBe("omit");
    expect((calls[0]?.headers as Record<string, string>).authorization).toBe("Bearer tt_unit");
  });

  test("with neither a token nor a session, nothing is sent", async () => {
    const api = createHttpApi({
      org: () => "acme",
      token: () => null,
      fetch: (async () => json({})) as unknown as typeof fetch,
    });
    await expect(api.listOrgs()).rejects.toBeInstanceOf(ApiError);
  });

  test("a step_up_required refusal reads as passkey confirmation", async () => {
    const { api } = make(() =>
      json(
        {
          error: {
            code: "forbidden",
            message: "create_api_token needs a fresh passkey step-up (step_up_required)",
            details: { reason: "step_up_required" },
          },
        },
        403,
      ),
    );
    const e = await api.approveRun({ runId: "r", headSha: "a", workflowHash: "b" }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe(PASSKEY_MESSAGE);
    expect(e.reason).toBe("step_up_required");
  });

  test("a write a session may never make reads as use-an-API-token", async () => {
    const { api } = make(() =>
      json(
        {
          error: {
            code: "forbidden",
            message:
              "rerun needs a passkey step-up, which this operation does not take for a web session: use a token",
            details: { reason: "step_up_required" },
          },
        },
        403,
      ),
    );
    const e = await api.approveRun({ runId: "r", headSha: "a", workflowHash: "b" }).catch((x) => x);
    expect(e.message).toBe(TOKEN_MESSAGE);
  });
});

describe("refusal mapping", () => {
  test("only forbidden refusals with a reason are rewritten", () => {
    expect(refusalMessage("forbidden", "m", { reason: "step_up_required" })).toBe(PASSKEY_MESSAGE);
    expect(refusalMessage("forbidden", "m", { reason: "step_up_expired" })).toContain("expired");
    expect(refusalMessage("forbidden", "cross-origin request refused", undefined)).toBeUndefined();
    expect(refusalMessage("not_found", "m", { reason: "step_up_required" })).toBeUndefined();
    expect(refusalMessage("forbidden", "m", { reason: "something_else" })).toBeUndefined();
  });
});

describe("sign out", () => {
  const CSRF = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const page = `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${CSRF}"><button>Sign out</button></form>`;

  test("csrfFromAuthPage reads the form's token", () => {
    expect(csrfFromAuthPage(page)).toBe(CSRF);
    expect(csrfFromAuthPage("<p>Sign in</p>")).toBeUndefined();
  });

  test("posts the CSRF token to /auth/logout, then leaves for /sign-in", async () => {
    resetSession(parseSession({ signed_in: true, github_login: "o", orgs: [{ slug: "a" }] }));
    const calls: { url: string; init: RequestInit }[] = [];
    let left = "";
    const r = await signOut({
      fetch: async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return url === "/auth" ? new Response(page) : new Response(null, { status: 303 });
      },
      leave: (to) => {
        left = to;
      },
    });
    expect(calls.map((c) => c.url)).toEqual(["/auth", "/auth/logout"]);
    const out = calls[1] as { init: RequestInit };
    expect(out.init.method).toBe("POST");
    expect(out.init.credentials).toBe("same-origin");
    expect(String(out.init.body)).toBe(`csrf=${CSRF}`);
    expect(r.ok).toBe(true);
    expect(left).toBe("/sign-in");
    expect(getSession().status).toBe("anonymous");
  });

  test("signs out locally even when the server cannot be reached", async () => {
    resetSession(parseSession({ signed_in: true, orgs: [] }));
    let left = "";
    const r = await signOut({
      fetch: async () => {
        throw new Error("down");
      },
      leave: (to) => {
        left = to;
      },
    });
    expect(r.ok).toBe(false);
    expect(left).toBe("/sign-in");
    expect(getSession().status).toBe("anonymous");
  });
});
