import { describe, expect, test } from "bun:test";
import { MAX_OPEN_PEM, Redactor, redactString, SecretRegistry } from "../src";

// Secret-shaped fixtures are assembled at runtime: SPLIT breaks each literal so secret scanners
// do not flag this file. It is the empty string.
const SPLIT = "";
const R = "***";
const url = (user: string, pass: string, rest: string): string =>
  ["https:/", "/", user, ":", pass, "@", rest].join("");
const GH = `gh${SPLIT}p_${"a1B2c3D4e5".repeat(4)}`; // 40 chars after the prefix
const PEM = [
  `-----BE${SPLIT}GIN RSA PRIVATE KEY-----`,
  "MIIEowIBAAKCAQEAx0dummykeymaterial0123456789abcdef",
  "ZmFrZWtleWZha2VrZXlmYWtla2V5",
  `-----EN${SPLIT}D RSA PRIVATE KEY-----`,
].join("\n");
const JWT = `ey${SPLIT}JhbGciOiJIUzI1NiJ9.ey${SPLIT}JzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r`;
const AWS_KEY = `AK${SPLIT}IAIOSFODNN7EXAMPLE`;
const AWS_SECRET = `wJalrXUt${SPLIT}nFEMIK7MDENGbPxRfiCYEXAMPLEKEYab`;

describe("patterns", () => {
  const cases: [string, string, string][] = [
    ["github ghp", `token ${GH} end`, `token ${R} end`],
    ["github gho", `x gh${SPLIT}o_${"Z".repeat(36)}`, `x ${R}`],
    ["github ghu", `gh${SPLIT}u_${"Z".repeat(36)}`, R],
    ["github ghs", `gh${SPLIT}s_${"Z".repeat(36)}`, R],
    ["github ghr", `gh${SPLIT}r_${"Z".repeat(36)}`, R],
    ["github fine-grained", `github${SPLIT}_pat_${"A1_".repeat(10)}xx`, R],
    [
      "npm",
      `//registry.npmjs.org/:_authToken=np${SPLIT}m_${"x9".repeat(18)}`,
      `//registry.npmjs.org/:_authToken=${R}`,
    ],
    [`aws key id AK${SPLIT}IA`, `id=${AWS_KEY}`, `id=${R}`],
    [`aws key id AS${SPLIT}IA`, `AS${SPLIT}IAIOSFODNN7EXAMPLE`, R],
    [
      "aws secret keeps key name",
      `aws_secret_access_key = ${AWS_SECRET}`,
      `aws_secret_access_key = ${R}`,
    ],
    ["aws secret env style", `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, `AWS_SECRET_ACCESS_KEY=${R}`],
    ["slack", `xo${SPLIT}xb-1234567890-abcdefghij`, R],
    [`slack xo${SPLIT}xp`, `xo${SPLIT}xp-1234567890-abcdefghij-zz`, R],
    ["jwt", `jwt: ${JWT}.`, `jwt: ${R}.`],
    ["bearer header", "Authorization: Bearer abc.DEF-123_456~xyz", `Authorization: Bearer ${R}`],
    ["bearer json", `{"Authorization": "Bearer abcdef123456"}`, `{"Authorization": "Bearer ${R}"}`],
    [
      "bearer curl lowercase",
      `-H 'authorization: bearer s3cr3tvalue99'`,
      `-H 'authorization: bearer ${R}'`,
    ],
    [
      "url password",
      `git clone ${url("user", "hunter2pass", "github.com/o/r.git")}`,
      `git clone ${url("user", R, "github.com/o/r.git")}`,
    ],
    ["pem", `before\n${PEM}\nafter`, `before\n${R}\nafter`],
    [
      "pem openssh",
      `-----BE${SPLIT}GIN OPENSSH PRIVATE KEY-----\nabc\n-----EN${SPLIT}D OPENSSH PRIVATE KEY-----`,
      R,
    ],
    ["pem bare", `-----BE${SPLIT}GIN PRIVATE KEY-----\nabc\n-----EN${SPLIT}D PRIVATE KEY-----`, R],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(redactString(input)).toBe(expected);
    });
  }

  test("two PEM blocks and text between are handled", () => {
    expect(redactString(`${PEM}\nmid\n${PEM}`)).toBe(`${R}\nmid\n${R}`);
  });
});

describe("no false positives on common log lines", () => {
  const clean = [
    "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
    "id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 started",
    "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    "Using Bearer authentication for the API",
    `https${SPLIT}://github.com/nc9/turntable/actions/runs/123`,
    `https${SPLIT}://user@example.com/path and ssh://git@host:22/repo`,
    `AK${SPLIT}IA is a prefix, AK${SPLIT}IAshort`,
    `gh${SPLIT}p_tooshort`,
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    `-----BE${SPLIT}GIN CERTIFICATE-----\nMIIB\n-----EN${SPLIT}D CERTIFICATE-----`,
    "npm WARN deprecated foo@1.0.0",
  ];
  for (const line of clean) {
    test(line.slice(0, 40), () => {
      expect(redactString(line)).toBe(line);
    });
  }
});

/** Pushes `text` in two chunks split at every offset and checks the output is identical. */
function splitEverywhere(text: string, expected: string, registry?: SecretRegistry): void {
  for (let i = 0; i <= text.length; i++) {
    const r = new Redactor({ registry });
    const out = r.push(text.slice(0, i)) + r.push(text.slice(i)) + r.end();
    if (out !== expected) {
      throw new Error(`split at ${i}: got ${JSON.stringify(out)} want ${JSON.stringify(expected)}`);
    }
  }
}

describe("split across chunks", () => {
  test("github token at every offset", () => {
    splitEverywhere(`pre ${GH} post`, `pre ${R} post`);
  });
  test("jwt at every offset", () => {
    splitEverywhere(`a ${JWT} b`, `a ${R} b`);
  });
  test("bearer header at every offset (prefix kept)", () => {
    splitEverywhere("x Authorization: Bearer abcdef123456789 y", `x Authorization: Bearer ${R} y`);
  });
  test("url password at every offset", () => {
    splitEverywhere(url("u", "supersecretpw", "h.io/x"), url("u", R, "h.io/x"));
  });
  test("pem at every offset", () => {
    splitEverywhere(`a\n${PEM}\nb`, `a\n${R}\nb`);
  });
  test("aws secret at every offset", () => {
    splitEverywhere(`aws_secret_access_key=${AWS_SECRET}!`, `aws_secret_access_key=${R}!`);
  });

  test("three-way and byte-at-a-time splits", () => {
    const text = `x ${GH} y ${AWS_KEY} z`;
    const r = new Redactor();
    let out = "";
    for (const ch of text) out += r.push(ch);
    out += r.end();
    expect(out).toBe(`x ${R} y ${R} z`);
  });

  test("clean text split anywhere is unchanged", () => {
    const text = "commit 9fceb02d0ae598e95dc970b74767f19372d61af8 ok\n".repeat(3);
    splitEverywhere(text, text);
  });

  test("a secret is never emitted partially before end", () => {
    const r = new Redactor();
    const parts = [
      r.push(`log gh${SPLIT}p_`),
      r.push("a1B2c3D4e5a1B2c3D4e5"),
      r.push("a1B2c3D4e5a1B2c3D4e5 tail"),
    ];
    expect(parts.join("")).not.toContain(`gh${SPLIT}p_`);
    expect(parts.join("") + r.end()).toBe(`log ${R} tail`);
  });

  test("utf-8 bytes split mid-character decode correctly", () => {
    const bytes = new TextEncoder().encode(`héllo 日本 ${GH} 😀`);
    for (let i = 0; i <= bytes.length; i++) {
      const r = new Redactor();
      const out = r.push(bytes.subarray(0, i)) + r.push(bytes.subarray(i)) + r.end();
      expect(out).toBe(`héllo 日本 ${R} 😀`);
    }
  });

  test("long clean stream emits output before end (bounded hold-back)", () => {
    const r = new Redactor();
    const line = "plain log line with nothing secret in it\n";
    let emitted = 0;
    let pushed = 0;
    for (let i = 0; i < 2000; i++) {
      pushed += line.length;
      emitted += r.push(line).length;
    }
    expect(pushed - emitted).toBeLessThan(10_000);
    emitted += r.end().length;
    expect(emitted).toBe(pushed);
  });
});

describe("pem edge cases", () => {
  test("unterminated pem is redacted at end", () => {
    expect(redactString(`a\n-----BE${SPLIT}GIN PRIVATE KEY-----\nabcdef`)).toBe(`a\n${R}`);
  });

  test("oversized pem is swallowed, not buffered forever, and later text survives", () => {
    const r = new Redactor();
    let out = r.push(`before\n-----BE${SPLIT}GIN PRIVATE KEY-----\n`);
    const body = "A".repeat(64 * 1024) + "\n";
    for (let i = 0; i < MAX_OPEN_PEM / body.length + 4; i++) out += r.push(body);
    out += r.push(`-----EN${SPLIT}D PRIVATE KEY-----\nafter`);
    out += r.end();
    expect(out).toBe(`before\n${R}\nafter`);
  });

  test("END marker split across chunks in swallow mode", () => {
    const r = new Redactor();
    let out = r.push(`-----BE${SPLIT}GIN PRIVATE KEY-----\n`);
    out += r.push("B".repeat(MAX_OPEN_PEM + 10));
    out += r.push(`\n-----EN${SPLIT}D PRIV`);
    out += r.push("ATE KEY-----\ndone");
    out += r.end();
    expect(out).toBe(`${R}\ndone`);
  });
});

describe("exact-value registry", () => {
  const secret = "s3cr3t/Value+with=chars!";
  const b64 = Buffer.from(secret).toString("base64");
  const b64url = b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

  test("raw, base64, base64url and url-encoded forms are redacted", () => {
    const reg = new SecretRegistry();
    expect(reg.register(secret).ok).toBe(true);
    const input = [secret, b64, b64.replace(/=+$/, ""), b64url, encodeURIComponent(secret)].join(
      " | ",
    );
    const out = redactString(input, reg);
    expect(out).toBe([R, R, R, R, R].join(" | "));
  });

  test("split across chunks at every offset, all forms", () => {
    const reg = new SecretRegistry();
    reg.register(secret);
    splitEverywhere(`x ${secret} y`, `x ${R} y`, reg);
    splitEverywhere(`x ${b64} y`, `x ${R} y`, reg);
    splitEverywhere(`x ${encodeURIComponent(secret)} y`, `x ${R} y`, reg);
  });

  test("values under 8 chars are refused with a warning and not redacted", () => {
    const warnings: string[] = [];
    const reg = new SecretRegistry({ warn: (m) => warnings.push(m) });
    const res = reg.register("tiny");
    expect(res.ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("tiny"); // never echo the value
    expect(redactString("a tiny word", reg)).toBe("a tiny word");
    expect(reg.register("exactly8").ok).toBe(true);
  });

  test("registry is per job: another job's values are not redacted", () => {
    const a = new SecretRegistry();
    a.register(secret);
    expect(redactString(secret, new SecretRegistry())).toBe(secret);
    expect(redactString(secret, a)).toBe(R);
  });

  test("a value registered mid-stream applies to later input", () => {
    const reg = new SecretRegistry();
    const r = new Redactor({ registry: reg });
    let out = r.push("one ");
    reg.register(secret);
    out += r.push(`two ${secret} three`);
    out += r.end();
    expect(out).toBe(`one two ${R} three`);
  });

  test("a value longer than the built-in window is still caught across chunks", () => {
    const reg = new SecretRegistry();
    const long = "k".repeat(20_000);
    reg.register(long);
    const text = `a ${long} b`;
    for (const i of [0, 1, 2, 10_000, 19_999, 20_001, text.length]) {
      const r = new Redactor({ registry: reg });
      expect(r.push(text.slice(0, i)) + r.push(text.slice(i)) + r.end()).toBe(`a ${R} b`);
    }
  });

  test("overlapping matches collapse to one replacement", () => {
    const reg = new SecretRegistry();
    reg.register(GH);
    expect(redactString(`x ${GH} y`, reg)).toBe(`x ${R} y`);
  });
});

describe("redos safety", () => {
  const budgetMs = 1500;
  const adversarial: [string, string][] = [
    ["jwt prefix repeated", `ey${SPLIT}J`.repeat(300_000)],
    ["jwt dots", `ey${SPLIT}J${"a".repeat(400)}.`.repeat(2000)],
    ["bearer header + long value", `Authorization: Bearer ${"a".repeat(1_000_000)}`],
    ["authorization with huge whitespace", `Authorization${" ".repeat(1_000_000)}`],
    ["authorization repeated", "Authorization: ".repeat(60_000)],
    ["userinfo scheme runs", "a".repeat(1_000_000)],
    ["userinfo colons", `http://${"a:".repeat(200_000)}`],
    ["url repeated", "http://u:".repeat(100_000)],
    ["aws secret key repeated", "aws_secret_access_key=".repeat(50_000)],
    ["pem begins without end", `-----BE${SPLIT}GIN PRIVATE KEY-----\n`.repeat(30_000)],
    ["pem begin fragments", `-----BE${SPLIT}GIN `.repeat(80_000)],
    ["github prefixes", `gh${SPLIT}p_`.repeat(250_000)],
    ["slack prefixes", `xo${SPLIT}xb-`.repeat(200_000)],
  ];
  for (const [name, input] of adversarial) {
    test(`${name} stays within budget`, () => {
      const t = performance.now();
      const r = new Redactor();
      let n = 0;
      // Feed in 4 KiB chunks like a real log stream.
      for (let i = 0; i < input.length; i += 4096) n += r.push(input.slice(i, i + 4096)).length;
      n += r.end().length;
      const ms = performance.now() - t;
      expect(n).toBeGreaterThan(0);
      expect(ms).toBeLessThan(budgetMs);
    });
  }
});

describe("line-aware emission", () => {
  test("a complete line is emitted immediately, the partial line is held", () => {
    const r = new Redactor();
    expect(r.push("line one\nline two\npart")).toBe("line one\nline two\n");
    expect(r.push("ial")).toBe("");
    expect(r.push(" done\n")).toBe("partial done\n");
    expect(r.end()).toBe("");
  });

  test("a secret on a complete line is redacted at once", () => {
    const r = new Redactor();
    expect(r.push(`token ${GH}\nnext`)).toBe(`token ${R}\n`);
    expect(r.end()).toBe("next");
  });

  test("partial line is held until a newline or flushIdle", () => {
    const r = new Redactor();
    expect(r.push("waiting for input...")).toBe("");
    expect(r.flushIdle()).toBe("waiting for input...");
    expect(r.push(" more\n")).toBe(" more\n");
  });

  test("flushIdle redacts a complete secret in the partial line", () => {
    const r = new Redactor();
    expect(r.push(`key=${GH}`)).toBe("");
    expect(r.flushIdle()).toBe(`key=${R}`);
  });

  test("flushIdle can leak the prefix of a token split across the gap (documented)", () => {
    const r = new Redactor();
    r.push(`tok gh${SPLIT}p_a1B2c3D4e5`);
    const early = r.flushIdle();
    expect(early).toContain(`gh${SPLIT}p_`); // trade-off: the partial token cannot be matched yet
  });

  test("flushIdle on an open PEM block emits *** and swallows the rest", () => {
    const r = new Redactor();
    let out = r.push(`x\n-----BE${SPLIT}GIN PRIVATE KEY-----\nAAAA\n`);
    out += r.flushIdle();
    out += r.push(`BBBB\n-----EN${SPLIT}D PRIVATE KEY-----\ny`);
    out += r.end();
    expect(out).toBe(`x\n${R}\ny`);
  });

  test("a line longer than the window still emits its head", () => {
    const r = new Redactor();
    const out = r.push("x".repeat(20_000));
    expect(out.length).toBeGreaterThan(10_000);
    expect(out + r.end()).toBe("x".repeat(20_000));
  });

  test("registered multi-line value split across lines is not leaked", () => {
    const reg = new SecretRegistry();
    reg.register("first-line-secret\nsecond-line-secret");
    const r = new Redactor({ registry: reg });
    const out = r.push("first-line-secret\n") + r.push("second-line-secret\ntail\n") + r.end();
    expect(out).toBe(`${R}\ntail\n`);
  });
});

describe("registry: base64 alignments", () => {
  const secret = "hunter2-correct-horse-battery";
  test("value embedded in a larger base64 blob at every alignment is redacted", () => {
    const reg = new SecretRegistry();
    reg.register(secret);
    for (let pre = 0; pre < 6; pre++) {
      for (let post = 0; post < 6; post++) {
        const blob = Buffer.from(`${"p".repeat(pre)}${secret}${"s".repeat(post)}`).toString(
          "base64",
        );
        const out = redactString(blob, reg);
        expect(out).toContain(R);
        // the secret's own base64 core must be gone
        expect(out.length).toBeLessThan(blob.length);
      }
    }
  });

  test("url-safe base64 alignments are covered", () => {
    const reg = new SecretRegistry();
    const s = "??>>??>>secret>>value??";
    reg.register(s);
    const blob = Buffer.from(`ab${s}cd`).toString("base64url");
    expect(redactString(blob, reg)).toContain(R);
  });
});
