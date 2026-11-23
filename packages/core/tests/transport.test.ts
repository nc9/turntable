import { afterAll, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { startServer } from "../src/server";
import {
  decideTransport,
  hstsValue,
  transportOptionsFromEnv,
  withHsts,
  type TransportOptions,
} from "../src/transport";

const trusting: TransportOptions = {
  trustForwardedProto: true,
  hstsMaxAge: 31_536_000,
  hstsIncludeSubDomains: true,
};
const plain: TransportOptions = { ...trusting, trustForwardedProto: false };

const req = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(url, { method, headers });

describe("decideTransport", () => {
  test("a trusted forwarded http GET or HEAD is redirected to the https URL, path and query kept", () => {
    for (const method of ["GET", "HEAD"]) {
      const d = decideTransport(
        req(
          "http://internal/a/b?x=1&y=2",
          { host: "ci.example.com", "x-forwarded-proto": "http" },
          method,
        ),
        trusting,
      );
      expect(d).toEqual({ action: "redirect", location: "https://ci.example.com/a/b?x=1&y=2" });
    }
  });

  test("a trusted forwarded http request with a body-carrying method is refused, not redirected", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        decideTransport(
          req(
            "http://internal/api",
            { host: "ci.example.com", "x-forwarded-proto": "http" },
            method,
          ),
          trusting,
        ),
      ).toEqual({ action: "reject" });
    }
  });

  test("the last forwarded hop decides, and a hostile Host header is never redirected to", () => {
    expect(
      decideTransport(
        req("http://x/", { host: "ci.example.com", "x-forwarded-proto": "http, https" }),
        trusting,
      ),
    ).toEqual({ action: "pass", secure: true });
    expect(
      decideTransport(
        req("http://x/", { host: "ci.example.com", "x-forwarded-proto": "https, http" }),
        trusting,
      ).action,
    ).toBe("redirect");
    for (const host of ["evil.com/@x", "a b", "user@evil.com", ""]) {
      expect(
        decideTransport(req("http://x/", { host, "x-forwarded-proto": "http" }), trusting).action,
      ).toBe("reject");
    }
  });

  test("a trusted forwarded https, and direct TLS, are secure", () => {
    expect(decideTransport(req("http://x/", { "x-forwarded-proto": "https" }), trusting)).toEqual({
      action: "pass",
      secure: true,
    });
    expect(decideTransport(req("https://x/"), plain)).toEqual({ action: "pass", secure: true });
  });

  test("an untrusted forwarded header changes nothing: no redirect, and it is not secure", () => {
    expect(
      decideTransport(req("http://x/", { "x-forwarded-proto": "http", host: "h.example" }), plain),
    ).toEqual({ action: "pass", secure: false });
    // and a forged "https" cannot earn HSTS or a bypass
    expect(decideTransport(req("http://x/", { "x-forwarded-proto": "https" }), plain)).toEqual({
      action: "pass",
      secure: false,
    });
  });

  test("loopback dev (no proxy headers) is untouched, trusting or not", () => {
    for (const o of [plain, trusting]) {
      expect(decideTransport(req("http://127.0.0.1:3000/healthz"), o)).toEqual({
        action: "pass",
        secure: false,
      });
      expect(decideTransport(req("http://localhost:3000/", {}, "POST"), o)).toEqual({
        action: "pass",
        secure: false,
      });
    }
  });
});

describe("HSTS", () => {
  test("the default value, custom max-age, no subdomains, and off", () => {
    expect(hstsValue(trusting)).toBe("max-age=31536000; includeSubDomains");
    expect(hstsValue({ ...trusting, hstsMaxAge: 600, hstsIncludeSubDomains: false })).toBe(
      "max-age=600",
    );
    expect(hstsValue({ ...trusting, hstsMaxAge: 0 })).toBeUndefined();
  });

  test("withHsts adds the header to any response, including one with immutable headers", async () => {
    const fetched = new Response("ok", { headers: { "content-type": "text/plain" } });
    const out = withHsts(fetched, trusting);
    expect(out.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(out.headers.get("content-type")).toBe("text/plain");
    expect(await out.text()).toBe("ok");
    expect(
      withHsts(new Response("x"), { ...trusting, hstsMaxAge: 0 }).headers.has(
        "strict-transport-security",
      ),
    ).toBe(false);
  });

  test("environment parsing", () => {
    expect(transportOptionsFromEnv({})).toEqual({
      trustForwardedProto: false,
      hstsMaxAge: 31_536_000,
      hstsIncludeSubDomains: true,
    });
    expect(
      transportOptionsFromEnv({
        TURNTABLE_TRUST_FORWARDED_PROTO: "1",
        TURNTABLE_HSTS_MAX_AGE: "off",
        TURNTABLE_HSTS_INCLUDE_SUBDOMAINS: "0",
      }),
    ).toEqual({
      trustForwardedProto: true,
      hstsMaxAge: 0,
      hstsIncludeSubDomains: false,
    });
    expect(transportOptionsFromEnv({ TURNTABLE_HSTS_MAX_AGE: "600" }).hstsMaxAge).toBe(600);
    expect(() => transportOptionsFromEnv({ TURNTABLE_HSTS_MAX_AGE: "soon" })).toThrow();
    expect(() => transportOptionsFromEnv({ TURNTABLE_HSTS_MAX_AGE: "-1" })).toThrow();
  });
});

describe("the running server", () => {
  const servers: { stop(force?: boolean): unknown }[] = [];
  afterAll(() => servers.forEach((s) => s.stop(true)));
  const boot = (transport: TransportOptions) => {
    const s = startServer({ port: 0, host: "127.0.0.1", db: openDatabase(":memory:"), transport });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const call = (base: string, path: string, headers: Record<string, string> = {}, method = "GET") =>
    fetch(`${base}${path}`, {
      method,
      headers: { host: "ci.example.com", ...headers },
      redirect: "manual",
    });

  test("plain http through a trusted proxy: GET 301, POST 400, https gets HSTS, no header means untouched", async () => {
    const base = boot(trusting);
    const redirect = await call(base, "/healthz?a=1", { "x-forwarded-proto": "http" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("https://ci.example.com/healthz?a=1");
    expect(redirect.headers.has("strict-transport-security")).toBe(false);
    const post = await call(base, "/api/v1/whoami", { "x-forwarded-proto": "http" }, "POST");
    expect(post.status).toBe(400);
    const secure = await call(base, "/healthz", { "x-forwarded-proto": "https" });
    expect(secure.status).toBe(200);
    expect(secure.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    const dev = await call(base, "/healthz");
    expect(dev.status).toBe(200);
    expect(dev.headers.has("strict-transport-security")).toBe(false);
  });

  test("not trusting the proxy: forwarded headers do nothing at all", async () => {
    const base = boot(plain);
    for (const proto of ["http", "https"]) {
      const res = await call(base, "/healthz", { "x-forwarded-proto": proto });
      expect(res.status).toBe(200);
      expect(res.headers.has("strict-transport-security")).toBe(false);
    }
  });

  test("HSTS off", async () => {
    const base = boot({ ...trusting, hstsMaxAge: 0 });
    const res = await call(base, "/healthz", { "x-forwarded-proto": "https" });
    expect(res.status).toBe(200);
    expect(res.headers.has("strict-transport-security")).toBe(false);
  });

  test("API errors and the OpenAPI document get HSTS over https too", async () => {
    const base = boot(trusting);
    for (const path of ["/openapi.json", "/api/v1/nope", "/nope"]) {
      const res = await call(base, path, { "x-forwarded-proto": "https" });
      expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    }
  });
});
