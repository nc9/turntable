import { describe, expect, test } from "bun:test";
import { MAX_OPEN_PEM, MAX_PATTERN_LENGTH, Redactor, redactString, SecretRegistry } from "../src";

// Secret-shaped fixtures are assembled at runtime: SPLIT breaks each literal so secret scanners
// do not flag this file. It is the empty string.
const SPLIT = "";
const R = "***";
const urlOf = (userinfo: string, rest: string): string =>
  ["https:/", "/", userinfo, "@", rest].join("");
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
      `git clone ${urlOf(R, "github.com/o/r.git")}`,
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
    splitEverywhere(url("u", "supersecretpw", "h.io/x"), urlOf(R, "h.io/x"));
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
    ["key lines repeated", "aws_secret_access_key:\n".repeat(50_000)],
    ["authorization lines repeated", "Authorization: Bearer\n  \n".repeat(40_000)],
    ["key then huge whitespace", `aws_secret_access_key${" ".repeat(1_000_000)}`],
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

/** Pushes `text` in two chunks split at `i`, with an idle flush between them. */
function withIdle(text: string, i: number, registry?: SecretRegistry): string {
  const r = new Redactor({ registry });
  return r.push(text.slice(0, i)) + r.flushIdle() + r.push(text.slice(i)) + r.end();
}

describe("idle flush never splits a marker or a key", () => {
  test("pem BEGIN marker split at every offset with an idle flush between", () => {
    const begin = `-----BE${SPLIT}GIN RSA PRIVATE KEY-----`;
    const body = "MIIEowIBAAKCAQEAdummybody0123\nZmFrZWtleQ==\n";
    const text = `x\n${begin}\n${body}-----EN${SPLIT}D RSA PRIVATE KEY-----\nafter`;
    const start = text.indexOf("\n") + 1;
    for (let i = start; i <= start + begin.length + 1; i++) {
      const out = withIdle(text, i);
      if (out !== `x\n${R}\nafter`) throw new Error(`split ${i}: ${JSON.stringify(out)}`);
    }
  });

  test("a partial marker prefix is held, a certificate header is not held forever", () => {
    const r = new Redactor();
    expect(r.push("log line -----BE")).toBe("");
    expect(r.flushIdle()).toBe("log line ");
    const r2 = new Redactor();
    r2.push(`${"-----"}BEGIN CERTIFICATE-----`);
    expect(r2.flushIdle()).toBe(`${"-----"}BEGIN CERTIFICATE`); // only the trailing dashes wait
    expect(r2.end()).toBe("-----");
  });

  test("a registered value split across an idle flush is held, not leaked", () => {
    const reg = new SecretRegistry();
    const secret = "registered-value-1234";
    reg.register(secret);
    const text = `x ${secret} y`;
    for (let i = 2; i <= 2 + secret.length; i++) {
      expect(withIdle(text, i, reg)).toBe(`x ${R} y`);
    }
  });
});

describe("whitespace and cross-line key/value", () => {
  test("any non-newline whitespace (CR, FF, VT) is allowed in header and key patterns", () => {
    const ws = "\r\u000b\u000c";
    expect(redactString(`Authorization:${ws}Bearer${ws}abcdef123456`)).toBe(
      `Authorization:${ws}Bearer${ws}${R}`,
    );
    expect(redactString(`aws_secret_access_key=${AWS_SECRET}\r\nnext\r\n`)).toBe(
      `aws_secret_access_key=${R}\r\nnext\r\n`,
    );
  });

  const aws = `a\naws_secret_access_key:\n  ${AWS_SECRET}\nz\n`;
  const bearer = `a\nAuthorization: Bearer\n  abcdef1234567890\nz\n`;
  const cases: [string, string, string, number][] = [
    ["aws yaml", aws, `a\naws_secret_access_key:\n  ${R}\nz\n`, aws.indexOf("  ")],
    ["bearer", bearer, `a\nAuthorization: Bearer\n  ${R}\nz\n`, bearer.indexOf("  ")],
  ];
  for (const [name, text, expected, valueAt] of cases) {
    test(`${name}: value on the next line is redacted at every split`, () => {
      splitEverywhere(text, expected);
    });
    test(`${name}: idle flush before the value keeps the key line held`, () => {
      for (let i = 2; i <= valueAt; i++) {
        const out = withIdle(text, i);
        if (out !== expected) throw new Error(`split ${i}: ${JSON.stringify(out)}`);
      }
    });
  }

  test("a key line alone is not flushed by idle, and is released once the next line shows", () => {
    const r = new Redactor();
    expect(r.push("aws_secret_access_key:\n")).toBe("");
    expect(r.flushIdle()).toBe("");
    expect(r.push(`${AWS_SECRET}\nmore\n`)).toBe(`aws_secret_access_key:\n${R}\nmore\n`);
    const r2 = new Redactor();
    expect(r2.push("Authorization: Bearer")).toBe("");
    expect(r2.flushIdle()).toBe("");
    expect(r2.end()).toBe("Authorization: Bearer");
  });

  test("an ordinary line after a key line is emitted unchanged, and releases the key line", () => {
    const r = new Redactor();
    expect(r.push("aws_secret_access_key:\n")).toBe("");
    expect(r.push("nothing secret here\nnext\n")).toBe(
      "aws_secret_access_key:\nnothing secret here\nnext\n",
    );
    expect(r.end()).toBe("");
  });
});

/** Pushes `text` in two chunks, the first `i` characters then the rest. */
function twoChunks(text: string, i: number): string {
  const r = new Redactor();
  return r.push(text.slice(0, i)) + r.push(text.slice(i)) + r.end();
}

/** Streams `text` in fixed-size chunks. */
function chunked(text: string, size: number): string {
  const r = new Redactor();
  let out = "";
  for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size));
  return out + r.end();
}

describe("a cut never lands inside a match prefix", () => {
  const filler = "x".repeat(50);
  const aws = `aws_secret_access_key = ${AWS_SECRET}`;
  const bearer = "Authorization: Bearer abcdef1234567890XYZ";
  const cases: [string, string, string][] = [
    ["aws", aws, "aws_secret_access_key = ***"],
    ["bearer", bearer, "Authorization: Bearer ***"],
    ["userinfo", urlOf("user:hunter2pass", "host.io/p"), urlOf(R, "host.io/p")],
  ];
  for (const [name, secret, expected] of cases) {
    test(`${name} on a line longer than the window, cut at every offset of the match`, () => {
      const text = `${filler}${secret} tail ${"y".repeat(MAX_PATTERN_LENGTH)}`;
      // The first push cuts `window - 1` characters before the end of what it has seen.
      for (let k = 0; k <= secret.length + 1; k++) {
        const i = filler.length + k + MAX_PATTERN_LENGTH - 1;
        const out = twoChunks(text, i);
        if (out !== `${filler}${expected} tail ${"y".repeat(MAX_PATTERN_LENGTH)}`) {
          throw new Error(`cut at match offset ${k}: ${JSON.stringify(out.slice(0, 200))}`);
        }
      }
    });
  }
});

describe("exceeding a bound never means not redacted", () => {
  const b64 = (n: number): string => "aB3_-".repeat(Math.ceil(n / 5)).slice(0, n);
  const seg = (n: number): string => b64(n).replaceAll("-", "x");
  const tokens: [string, string, string][] = [
    ["jwt payload over 4096", `ey${SPLIT}J${seg(30)}.ey${SPLIT}J${seg(6000)}.${seg(40)}`, R],
    ["jwt signature over 4096", `ey${SPLIT}J${seg(30)}.ey${SPLIT}J${seg(30)}.${seg(6000)}`, R],
    ["jwt header over 1024", `ey${SPLIT}J${seg(3000)}.ey${SPLIT}J${seg(30)}.${seg(40)}`, R],
    ["github token over 255", `gh${SPLIT}p_${"a1B2".repeat(200)}`, R],
    ["fine-grained token over 255", `github${SPLIT}_pat_${"a1B_".repeat(200)}`, R],
    ["npm token over 255", `np${SPLIT}m_${"a1B2".repeat(200)}`, R],
    ["slack token over 250", `xo${SPLIT}xb-${"1a-".repeat(200)}`, R],
    [
      "bearer over 4096",
      `Authorization: Bearer ${"Ab1.".repeat(2000)}`,
      `Authorization: Bearer ${R}`,
    ],
    [
      "aws secret over 40",
      `aws_secret_access_key=${AWS_SECRET}${"Q".repeat(30)}`,
      `aws_secret_access_key=${R}`,
    ],
  ];
  for (const [name, token, expected] of tokens) {
    test(`${name}: one shot and chunked`, () => {
      expect(redactString(`x ${token} y`)).toBe(`x ${expected} y`);
      for (const size of [1000, 4096, 777]) {
        expect(chunked(`x ${token} y`, size)).toBe(`x ${expected} y`);
      }
    });
    test(`${name}: cut at sampled offsets`, () => {
      const text = `x ${token} y`;
      for (let i = 0; i <= text.length; i += 53) {
        const out = twoChunks(text, i);
        if (out !== `x ${expected} y`)
          throw new Error(`cut ${i}: ${JSON.stringify(out.slice(0, 120))}`);
      }
    });
  }

  test("the swallowed continuation stops at the first character outside the token", () => {
    const r = new Redactor();
    let out = r.push(`k gh${SPLIT}p_${"a1B2".repeat(100)}`); // past the bound, run reaches the end
    out += r.push("a1B2a1B2");
    out += r.push(` tail\nnext`);
    out += r.end();
    expect(out).toBe(`k ${R} tail\nnext`);
  });

  test("a bounded jwt keeps its trailing punctuation", () => {
    expect(redactString(`jwt ${JWT}. ok`)).toBe(`jwt ${R}. ok`);
  });
});

describe("url userinfo", () => {
  test("empty username", () => {
    expect(redactString(urlOf(":pass1234word", "host.io/"))).toBe(urlOf(R, "host.io/"));
  });
  test("slash in the password, up to the last @ of the token", () => {
    expect(redactString(urlOf("user:pa/ss/word99", "host.io/x"))).toBe(urlOf(R, "host.io/x"));
    expect(redactString(urlOf("user:pa@ss@word", "host.io/x"))).toBe(urlOf(R, "host.io/x"));
  });
  test("the whole userinfo is redacted, username included", () => {
    expect(redactString(urlOf("deploy-bot:s3cret-value", "git.io/r.git"))).toBe(
      urlOf(R, "git.io/r.git"),
    );
  });
  test("over-long passwords are truncated, never dropped", () => {
    for (const n of [300, 3000]) {
      const u = urlOf(`user:${"p4ss".repeat(n / 4)}`, "host.io/x");
      const out = redactString(`a ${u} b`);
      expect(out).not.toContain("p4ssp4ss");
      expect(out.startsWith(`a ${urlOf("", "").slice(0, 8)}`)).toBe(true);
      expect(out.endsWith(" b") || out.endsWith("***")).toBe(true);
      expect(chunked(`a ${u} b`, 500)).toBe(out);
    }
  });
  test("a port or a scoped npm path is not userinfo", () => {
    const clean = [
      "http://localhost:4873/@scope/pkg",
      "https://example.com:8080/a@b",
      "https://user@example.com/path",
    ];
    for (const c of clean) expect(redactString(c)).toBe(c);
  });
});
