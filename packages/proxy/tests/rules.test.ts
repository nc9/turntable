import { describe, expect, test } from "bun:test";
import {
  checkPath,
  compileRule,
  compileRules,
  hostAllowed,
  matchRule,
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
