import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  checkBody,
  checkPath,
  compileRule,
  compileRules,
  hostAllowed,
  matchRule,
  npmExactRule,
  npmPath,
  underPrefix,
  wireValue,
} from "../src/rules";
import { type Rule, RuleError } from "../src/types";

const base: Rule = {
  id: "npm",
  host: "registry.example.test",
  methods: ["GET", "HEAD"],
  pathPrefix: "/v1/",
  inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
  secret: "NPM_TOKEN",
};
const rules = compileRules([base]);

describe("rule validation", () => {
  test("a rule names one exact lower-case host, never an IP literal or a wildcard", () => {
    for (const host of ["*.example.test", "10.0.0.1", "[::1]", "UPPER.test", "a b.test", ""]) {
      expect(() => compileRule({ ...base, host })).toThrow(RuleError);
    }
  });

  test("methods are explicit: empty and the wildcard are refused", () => {
    expect(() => compileRule({ ...base, methods: [] })).toThrow(RuleError);
    expect(() => compileRule({ ...base, methods: ["*"] })).toThrow(RuleError);
    expect(() => compileRule({ ...base, methods: ["get"] })).toThrow(RuleError);
  });

  test("an injecting rule must name its secret; a canonical path prefix is required", () => {
    expect(() => compileRule({ ...base, secret: undefined })).toThrow(RuleError);
    expect(() => compileRule({ ...base, pathPrefix: "v1" })).toThrow(RuleError);
    expect(() => compileRule({ ...base, pathPrefix: "/a/../b" })).toThrow(RuleError);
    expect(compileRule({ ...base, inject: { type: "none" }, secret: undefined }).port).toBe(443);
  });

  test("a rule cannot set a header that frames or routes the request", () => {
    for (const name of ["Host", "Content-Length", "Transfer-Encoding", "Proxy-Authorization"]) {
      expect(() => compileRule({ ...base, inject: { type: "header", name } })).toThrow(RuleError);
    }
    expect(() =>
      compileRule({ ...base, inject: { type: "header", name: "X-Token", format: "no" } }),
    ).toThrow(RuleError);
  });

  test("rule ids are unique within a job", () => {
    expect(() => compileRules([base, base])).toThrow(RuleError);
  });
});

describe("path scope", () => {
  test.each([
    ["/v1/pkg", true],
    ["/v1/", true],
    ["/v1", true],
    ["/v10/pkg", false],
    ["/v1x", false],
    ["/other", false],
  ])("a prefix matches on segment boundaries: %s", (path, ok) => {
    expect(underPrefix(path, "/v1/")).toBe(ok);
  });

  test.each([
    "/v1/../admin",
    "/v1/./x",
    "/v1/%2e%2e/admin",
    "/v1/%2E/x",
    "/v1/a%2fb",
    "/v1/a%5Cb",
    "/v1/a\\b",
    "/v1//x",
    "/v1/a%00b",
    "/v1/a b",
    "/v1/é",
    "v1/x",
    "/v1/..;/x",
    "/v1/.;x/y",
    "/v1/a;b",
    "/v1/%2E%2E/x",
    "/v1/a%2Fb",
    "/v1/a%5Cb",
  ])("a path that is not canonical is refused, never normalised: %s", (path) => {
    expect(checkPath(path)).toBeDefined();
  });

  test.each(["/", "/v1/pkg", "/v1/pkg/", "/v1/a%20b", "/v1/a-b_c.d~e", "/v1/a%2Bb"])(
    "an ordinary canonical path is accepted: %s",
    (path) => {
      expect(checkPath(path)).toBeUndefined();
    },
  );
});

describe("rule matching", () => {
  test("a host with no rule is refused", () => {
    expect(hostAllowed(rules, "registry.example.test", 443)).toBe(true);
    expect(hostAllowed(rules, "evil.example.test", 443)).toBe(false);
    expect(hostAllowed(rules, "registry.example.test", 8443)).toBe(false);
    expect(matchRule(rules, "evil.example.test", 443, "GET", "/v1/x")).toEqual({
      ok: false,
      reason: "no_rule_for_host",
    });
  });

  test("method and path must both match; the reason names which did not", () => {
    expect(matchRule(rules, "registry.example.test", 443, "GET", "/v1/x").ok).toBe(true);
    expect(matchRule(rules, "registry.example.test", 443, "POST", "/v1/x")).toEqual({
      ok: false,
      reason: "no_rule_for_method",
    });
    expect(matchRule(rules, "registry.example.test", 443, "GET", "/v2/x")).toEqual({
      ok: false,
      reason: "no_rule_for_path",
    });
  });

  test("the narrowest matching prefix wins", () => {
    const two = compileRules([
      { ...base, id: "broad", pathPrefix: "/", inject: { type: "none" }, secret: undefined },
      { ...base, id: "narrow", pathPrefix: "/v1/" },
    ]);
    const m = matchRule(two, "registry.example.test", 443, "GET", "/v1/x");
    expect(m.ok && m.rule.id).toBe("narrow");
    const outside = matchRule(two, "registry.example.test", 443, "GET", "/public");
    expect(outside.ok && outside.rule.id).toBe("broad");
  });
});

describe("what goes on the wire", () => {
  test("a header rule formats the value and lists every form to scrub", () => {
    const w = wireValue(base.inject, "s3cr3t-value");
    expect(w).toEqual({
      header: "authorization",
      value: "Bearer s3cr3t-value",
      scrub: ["s3cr3t-value", "Bearer s3cr3t-value"],
    });
  });

  test("a basic rule encodes user:secret and lists the pair and the encoded header", () => {
    const w = wireValue({ type: "basic", username: "ci" }, "s3cr3t-value");
    expect(w.header).toBe("authorization");
    expect(w.value).toBe(`Basic ${Buffer.from("ci:s3cr3t-value").toString("base64")}`);
    expect(w.scrub).toEqual(["s3cr3t-value", "ci:s3cr3t-value", w.value]);
  });
});

describe("publish rules: npm package paths, exact paths, body checks", () => {
  const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
  const npmRule: Rule = {
    ...base,
    id: "npm-pkg",
    methods: ["GET", "PUT"],
    pathPrefix: "/@acme%2Fweb",
    npmPackage: "@acme/web",
  };

  test("npmPackage accepts exactly its own encoded path, and implies exact match", () => {
    const [r] = compileRules([npmRule]);
    expect(r!.pathExact).toBe(true);
    expect(matchRule([r!], base.host, 443, "PUT", "/@acme%2Fweb").ok).toBe(true);
    for (const p of [
      "/@acme%2Fweb/x",
      "/@acme%2Fweb/",
      "/@acme%2Fother",
      "/@acme/web",
      "/@acme%2fweb",
    ]) {
      expect(matchRule([r!], base.host, 443, "PUT", p).ok).toBe(false);
    }
    expect(npmExactRule([r!], base.host, 443, "/@acme%2Fweb")).toBe(true);
    expect(npmExactRule([r!], base.host, 443, "/@acme%2Fother")).toBe(false);
    expect(npmPath("web")).toBe("/web");
  });

  test("npmPackage is validated: a name, and the matching path", () => {
    expect(() => compileRule({ ...npmRule, npmPackage: "../x" })).toThrow(RuleError);
    expect(() => compileRule({ ...npmRule, npmPackage: "@acme/web/extra" })).toThrow(RuleError);
    expect(() => compileRule({ ...npmRule, pathPrefix: "/@acme%2Fother" })).toThrow(RuleError);
    // without npmPackage an encoded slash is still not a canonical path
    expect(() => compileRule({ ...npmRule, npmPackage: undefined })).toThrow(RuleError);
  });

  test("pathExact matches only that path", () => {
    const [r] = compileRules([{ ...base, pathPrefix: "/v2/", pathExact: true }]);
    expect(matchRule([r!], base.host, 443, "GET", "/v2/").ok).toBe(true);
    expect(matchRule([r!], base.host, 443, "GET", "/v2/other/").ok).toBe(false);
  });

  test("bodyCheck digests must be sha256 hex", () => {
    for (const digests of [[], ["abc"], ["A".repeat(64)]]) {
      expect(() => compileRule({ ...base, bodyCheck: { type: "sha256", digests } })).toThrow(
        RuleError,
      );
    }
    expect(() =>
      compileRule({ ...base, bodyCheck: { type: "json", field: "a b", equals: true } }),
    ).toThrow(RuleError);
  });

  const publishDoc = (tgz: Buffer, over: Record<string, unknown> = {}): Buffer =>
    Buffer.from(
      JSON.stringify({
        name: "@acme/web",
        versions: {
          "1.0.0": {
            dist: { integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` },
          },
        },
        _attachments: { "@acme/web-1.0.0.tgz": { data: tgz.toString("base64") } },
        ...over,
      }),
    );

  test("npm-publish: the one attachment must be an approved tarball and the metadata honest", () => {
    const tgz = Buffer.from("tarball bytes");
    const check = { type: "npm-publish" as const, digests: [sha(tgz)] };
    expect(checkBody(check, publishDoc(tgz))).toEqual({ ok: true });
    const other = publishDoc(Buffer.from("other bytes"));
    expect(checkBody(check, other)).toMatchObject({ ok: false, reason: "digest_not_approved" });
    expect(checkBody(check, publishDoc(tgz, { _attachments: {} }))).toMatchObject({
      reason: "attachment_count",
    });
    expect(
      checkBody(
        check,
        publishDoc(tgz, {
          _attachments: {
            a: { data: tgz.toString("base64") },
            b: { data: tgz.toString("base64") },
          },
        }),
      ),
    ).toMatchObject({ reason: "attachment_count" });
    expect(
      checkBody(
        check,
        publishDoc(tgz, { versions: { "1.0.0": { dist: { integrity: "sha512-x" } } } }),
      ),
    ).toMatchObject({ reason: "integrity_mismatch" });
    expect(
      checkBody(check, publishDoc(tgz, { versions: { "1.0.0": {}, "1.0.1": {} } })),
    ).toMatchObject({ reason: "version_count" });
    expect(checkBody(check, Buffer.from("not json"))).toMatchObject({ reason: "not_json" });
    expect(checkBody(check, Buffer.from("[]"))).toMatchObject({ reason: "not_an_object" });
  });

  test("sha256 and json checks", () => {
    const body = Buffer.from('{"draft":true,"tag_name":"v1"}');
    expect(checkBody({ type: "sha256", digests: [sha(body)] }, body)).toEqual({ ok: true });
    expect(checkBody({ type: "sha256", digests: [sha("x")] }, body)).toMatchObject({
      reason: "digest_not_approved",
    });
    expect(checkBody({ type: "json", field: "draft", equals: true }, body)).toEqual({ ok: true });
    for (const b of ['{"draft":false}', '{"draft":"true"}', "{}", '{"x":{"draft":true}}']) {
      expect(
        checkBody({ type: "json", field: "draft", equals: true }, Buffer.from(b)),
      ).toMatchObject({
        ok: false,
      });
    }
  });

  test("an oci-bearer rule: scope and username are validated, and the wire value is the exchange credential", () => {
    const oci: Rule = {
      ...base,
      host: "ghcr.io",
      inject: { type: "oci-bearer", username: "bot", scope: "repository:acme/web:push,pull" },
    };
    expect(() => compileRule(oci)).not.toThrow();
    for (const scope of ["repository:acme/web:*", "catalog:*", "repository:ACME/web:pull"]) {
      expect(() =>
        compileRule({ ...oci, inject: { type: "oci-bearer", username: "bot", scope } }),
      ).toThrow(RuleError);
    }
    expect(() =>
      compileRule({
        ...oci,
        inject: { type: "oci-bearer", username: "a:b", scope: "repository:a/b:pull" },
      }),
    ).toThrow(RuleError);
    expect(wireValue(oci.inject, "s3cretvalue-xyz").value.startsWith("Basic ")).toBe(true);
  });
});
