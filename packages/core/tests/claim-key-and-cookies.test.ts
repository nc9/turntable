// The claim and sign-in state keys are created atomically and shared (#465), and parallel claims in
// one browser each keep their own binding cookie (#443). Clocks are relative to the real time.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { KeyCache } from "../src/secrets/ensure-key";
import { createOrg } from "../src/db";
import {
  CLAIM_PATH,
  CLAIM_START_PATH,
  claimCookieName,
  claimCsrfCookieName,
  createClaimHandler,
  InstallationClaims,
  SECRET_CLAIM_KEY,
} from "../src/github/claim";
import { MAX_FLOW_COOKIES } from "../src/auth/flow-cookies";
import {
  type FakeClaimUser,
  fakeFacts,
  fakeUserVerifier,
  inst,
  repo,
  setup,
} from "./github-helpers";

const stateOf = (url: string): string => new URL(url, "http://x").searchParams.get("state")!;
const nonceOf = (state: string): string =>
  JSON.parse(Buffer.from(state.split(".")[1]!, "base64url").toString()).n as string;

const owner: FakeClaimUser = {
  id: "9",
  login: "owner-b",
  installations: [
    { id: "100", accountId: "7", accountLogin: "acme", accountType: "Organization" },
    { id: "101", accountId: "7", accountLogin: "acme", accountType: "Organization" },
  ],
  adminOf: ["acme"],
};

async function harness() {
  const s = await setup();
  const tenant = await createOrg(s.db, { slug: "tenant-b", name: "Tenant B" });
  const f = fakeFacts();
  for (const id of ["100", "101"]) {
    f.installations.set(id, inst(id));
    f.repos.set(id, [repo(`r${id}`, `api${id}`)]);
  }
  const users = new Map<string, FakeClaimUser>([["code", owner]]);
  const claims = new InstallationClaims({ db: s.db, store: s.store });
  const handler = createClaimHandler({
    claims,
    facts: f.facts,
    user: fakeUserVerifier(users),
    log: () => {},
  });
  /** A browser: confirms a claim (the page, then the click) and returns the cookies it now holds. */
  const confirm = async (url: string, jar: Map<string, string>) => {
    const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const page = (await handler.handle(
      new Request(`http://x${url}`, { headers: { cookie: cookieHeader() } }),
    ))!;
    const html = await page.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const take = (res: Response) => {
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(";");
        const i = kv!.indexOf("=");
        const name = kv!.slice(0, i);
        if (c.includes("Max-Age=0")) jar.delete(name);
        else jar.set(name, kv!.slice(i + 1));
      }
    };
    take(page);
    const state = stateOf(url);
    const go = (await handler.handle(
      new Request(`http://x${CLAIM_START_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          cookie: cookieHeader(),
        },
        body: new URLSearchParams({ state, csrf }),
      }),
    ))!;
    take(go);
    return go;
  };
  const callback = async (q: Record<string, string>, jar: Map<string, string>) =>
    (await handler.handle(
      new Request(`http://x${CLAIM_PATH}?${new URLSearchParams(q)}`, {
        headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
      }),
    ))!;
  return { ...s, tenant, f, claims, handler, confirm, callback };
}

describe("claim state key (#465)", () => {
  test("two concurrent first starts both produce states that verify", async () => {
    const h = await harness();
    expect(await h.store.has(h.org.id, SECRET_CLAIM_KEY)).toBe(false);
    const [a, b] = await Promise.all([
      h.claims.start(h.tenant.id, "token:a", { installationId: "100" }),
      h.claims.start(h.tenant.id, "token:b", { installationId: "101" }),
    ]);
    expect(await h.claims.verify(stateOf(a.url))).toBeDefined();
    expect(await h.claims.verify(stateOf(b.url))).toBeDefined();
  });

  test("a second instance over the same store, racing the first, uses the same key", async () => {
    const h = await harness();
    const other = new InstallationClaims({ db: h.db, store: h.store });
    const [a, b] = await Promise.all([
      h.claims.start(h.tenant.id, "token:a"),
      other.start(h.tenant.id, "token:b"),
    ]);
    expect(await other.verify(stateOf(a.url))).toBeDefined();
    expect(await h.claims.verify(stateOf(b.url))).toBeDefined();
  });

  test("insert-if-absent never replaces a stored value", async () => {
    const h = await harness();
    expect(await h.store.setIfAbsent(h.org.id, "k/test", "first")).toBe(true);
    expect(await h.store.setIfAbsent(h.org.id, "k/test", "second")).toBe(false);
    expect(await h.store.get(h.org.id, "k/test")).toBe("first");
  });

  test("a stale process cache recovers by re-reading the store", async () => {
    const h = await harness();
    const { url } = await h.claims.start(h.tenant.id, "token:a"); // caches key 1
    // the stored key changes under this process (another process rotated it)
    const fresh = new InstallationClaims({ db: h.db, store: h.store });
    await h.store.set(h.org.id, SECRET_CLAIM_KEY, randomBytes(32).toString("base64url"));
    const { url: url2 } = await fresh.start(h.tenant.id, "token:b"); // signs with the new key
    // the stale process still verifies the new state, by re-reading once
    expect(await h.claims.verify(stateOf(url2))).toBeDefined();
    // and a state signed with the replaced key no longer verifies
    expect(await h.claims.verify(stateOf(url))).toBeUndefined();
  });

  test("the key cache never holds a value the store does not", async () => {
    const h = await harness();
    const cache = new KeyCache(h.store, "github-app/login-state-key");
    const [x, y] = await Promise.all([
      cache.get(h.org.id),
      new KeyCache(h.store, "github-app/login-state-key").get(h.org.id),
    ]);
    expect(x.equals(y)).toBe(true);
    const stored = Buffer.from(
      (await h.store.get(h.org.id, "github-app/login-state-key"))!,
      "base64url",
    );
    expect(x.equals(stored)).toBe(true);
  });
});

describe("per-claim cookies (#443)", () => {
  test("two parallel claims in one browser both complete", async () => {
    const h = await harness();
    const jar = new Map<string, string>();
    const a = await h.claims.start(h.tenant.id, "token:a", { installationId: "100" });
    const b = await h.claims.start(h.tenant.id, "token:b", { installationId: "101" });
    const sa = stateOf(a.url);
    const sb = stateOf(b.url);
    await h.confirm(a.url, jar);
    await h.confirm(b.url, jar);
    // two distinct binding cookies are held at once
    expect(jar.has(claimCookieName(nonceOf(sa)))).toBe(true);
    expect(jar.has(claimCookieName(nonceOf(sb)))).toBe(true);
    expect(claimCookieName(nonceOf(sa))).not.toBe(claimCookieName(nonceOf(sb)));
    const ra = await h.callback(
      { installation_id: "100", setup_action: "install", state: sa, code: "code" },
      jar,
    );
    expect(ra.status).toBe(200);
    // finishing the first leaves the second claim's cookie alone
    expect(jar.has(claimCookieName(nonceOf(sa)))).toBe(false);
    for (const c of ra.headers.getSetCookie()) {
      const [kv] = c.split(";");
      if (c.includes("Max-Age=0")) jar.delete(kv!.split("=")[0]!);
    }
    expect(jar.has(claimCookieName(nonceOf(sb)))).toBe(true);
    const rb = await h.callback(
      { installation_id: "101", setup_action: "install", state: sb, code: "code" },
      jar,
    );
    expect(rb.status).toBe(200);
  });

  test("a callback holding only the other claim's cookie is refused", async () => {
    const h = await harness();
    const a = await h.claims.start(h.tenant.id, "token:a", { installationId: "100" });
    const b = await h.claims.start(h.tenant.id, "token:b", { installationId: "101" });
    const jar = new Map<string, string>();
    await h.confirm(b.url, jar); // the browser confirmed only b
    const res = await h.callback(
      { installation_id: "100", setup_action: "install", state: stateOf(a.url), code: "code" },
      jar,
    );
    expect(res.status).toBe(403);
    // a cookie named for a but carrying b's nonce is not a's cookie either
    const nb = nonceOf(stateOf(b.url));
    const forged = new Map([[claimCookieName(nonceOf(stateOf(a.url))), nb]]);
    const res2 = await h.callback(
      { installation_id: "100", setup_action: "install", state: stateOf(a.url), code: "code" },
      forged,
    );
    expect(res2.status).toBe(403);
  });

  test("the configure redirect (no state) finds its claim among several cookies", async () => {
    const h = await harness();
    const jar = new Map<string, string>();
    const a = await h.claims.start(h.tenant.id, "token:a", { installationId: "100" });
    const b = await h.claims.start(h.tenant.id, "token:b", { installationId: "101" });
    await h.confirm(a.url, jar);
    await h.confirm(b.url, jar);
    const res = await h.callback(
      { installation_id: "101", setup_action: "update", code: "code" },
      jar,
    );
    expect(res.status).toBe(200);
    // it claimed 101 only
    const wrong = await h.callback(
      { installation_id: "100", setup_action: "update", code: "code" },
      jar,
    );
    expect(wrong.status).toBe(200);
  });

  test("the cookie cap holds: the claims ending soonest are expired first", async () => {
    const h = await harness();
    let t = Date.now();
    const jar = new Map<string, string>();
    const nonces: string[] = [];
    // Start more claims than the cap, spaced apart so their expiries order them.
    const claims = new InstallationClaims({ db: h.db, store: h.store, now: () => t });
    const handler = createClaimHandler({
      claims,
      facts: h.f.facts,
      user: fakeUserVerifier(new Map([["code", owner]])),
      log: () => {},
    });
    const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    for (let i = 0; i < MAX_FLOW_COOKIES + 2; i++) {
      t += 1000;
      const { url } = await claims.start(h.tenant.id, `token:${i}`);
      nonces.push(nonceOf(stateOf(url)));
      const page = (await handler.handle(
        new Request(`http://x${url}`, { headers: { cookie: header() } }),
      ))!;
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.clone().text())![1]!;
      const apply = (res: Response) => {
        for (const c of res.headers.getSetCookie()) {
          const [kv] = c.split(";");
          const k = kv!.indexOf("=");
          if (c.includes("Max-Age=0")) jar.delete(kv!.slice(0, k));
          else jar.set(kv!.slice(0, k), kv!.slice(k + 1));
        }
      };
      apply(page);
      const go = (await handler.handle(
        new Request(`http://x${CLAIM_START_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
            cookie: header(),
          },
          body: new URLSearchParams({ state: stateOf(url), csrf }),
        }),
      ))!;
      apply(go);
      const claimCookies = [...jar.keys()].filter((k) => /^ls_claim_[0-9a-f]{16}$/.test(k));
      expect(claimCookies.length).toBeLessThanOrEqual(MAX_FLOW_COOKIES);
      const csrfCookies = [...jar.keys()].filter((k) => k.startsWith("ls_claim_csrf_"));
      expect(csrfCookies.length).toBeLessThanOrEqual(MAX_FLOW_COOKIES);
    }
    // the newest claim is always kept, the earliest are gone
    expect(jar.has(claimCookieName(nonces[nonces.length - 1]!))).toBe(true);
    expect(jar.has(claimCookieName(nonces[0]!))).toBe(false);
    expect(claimCsrfCookieName(nonces[0]!)).not.toBe(claimCookieName(nonces[0]!));
  });
});
