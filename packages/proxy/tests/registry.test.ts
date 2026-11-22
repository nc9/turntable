import { describe, expect, test } from "bun:test";
import { AttemptRegistry } from "../src/registry";
import type { AttemptSpec } from "../src/types";

const spec = (id: string, ttlMs = 60_000): AttemptSpec => ({
  attemptId: id,
  orgId: "o",
  projectId: "p",
  runId: "r",
  jobId: "j",
  ttlMs,
  rules: [
    {
      id: "a",
      host: "api.example.test",
      methods: ["GET"],
      pathPrefix: "/",
      inject: { type: "none" },
    },
  ],
});
const header = (u: string, p: string): string =>
  `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("per-attempt proxy credentials", () => {
  test("the credential given to the job authenticates its own attempt", () => {
    const reg = new AttemptRegistry();
    const c = reg.register(spec("att1"));
    const r = reg.authenticate(header(c.username, c.password));
    expect(r.ok && r.attempt.spec.attemptId).toBe("att1");
    expect(c.proxyUrl("127.0.0.1", 8888)).toBe(`http://att1:${c.password}@127.0.0.1:8888`);
  });

  test("another attempt's credential does not authenticate, and unknown, wrong and malformed all fail", () => {
    const reg = new AttemptRegistry();
    const one = reg.register(spec("att1"));
    const two = reg.register(spec("att2"));
    // One attempt's token under the other's id.
    expect(reg.authenticate(header("att1", two.password))).toMatchObject({
      ok: false,
      reason: "bad_credential",
    });
    expect(reg.authenticate(header("nobody", one.password))).toMatchObject({
      ok: false,
      reason: "unknown_attempt",
    });
    expect(reg.authenticate(header("att1", "wrong"))).toMatchObject({
      ok: false,
      reason: "bad_credential",
    });
    for (const h of [undefined, "", "Bearer x", "Basic !!", header("", "x"), "Basic"]) {
      expect(reg.authenticate(h)).toMatchObject({ ok: false });
    }
  });

  test("expired attempt credential is refused, and per request too", () => {
    let now = 1_000_000;
    const reg = new AttemptRegistry({ now: () => now });
    const c = reg.register(spec("att1", 5_000));
    const ok = reg.authenticate(header(c.username, c.password));
    expect(ok.ok).toBe(true);
    now += 5_000;
    expect(reg.authenticate(header(c.username, c.password))).toMatchObject({
      ok: false,
      reason: "expired",
    });
    if (ok.ok) expect(reg.live(ok.attempt)).toBe(false);
  });

  test("a revoked credential stops working and its tunnels are closed", () => {
    const reg = new AttemptRegistry();
    const c = reg.register(spec("att1"));
    const r = reg.authenticate(header(c.username, c.password));
    let closed = 0;
    if (r.ok) r.attempt.tunnels.add({ destroy: () => closed++ });
    reg.revoke("att1");
    expect(closed).toBe(1);
    expect(reg.authenticate(header(c.username, c.password))).toMatchObject({
      ok: false,
      reason: "revoked",
    });
  });

  test("the token is stored only as a hash", () => {
    const reg = new AttemptRegistry();
    const c = reg.register(spec("att1"));
    const r = reg.authenticate(header(c.username, c.password));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(
        JSON.stringify(r.attempt, (_k, v) => (v instanceof Buffer ? v.toString("hex") : v)),
      ).not.toContain(c.password);
    }
  });

  test("an attempt id is registered once and must be plain; rules are validated at registration", () => {
    const reg = new AttemptRegistry();
    reg.register(spec("att1"));
    expect(() => reg.register(spec("att1"))).toThrow();
    expect(() => reg.register(spec("bad id"))).toThrow();
    expect(() =>
      reg.register({ ...spec("att3"), rules: [{ ...spec("x").rules[0]!, host: "*.x.test" }] }),
    ).toThrow();
  });

  test("sweeping drops ended attempts", () => {
    let now = 0;
    const reg = new AttemptRegistry({ now: () => now });
    reg.register(spec("a", 1000));
    reg.register(spec("b", 100_000));
    now = 2000;
    expect(reg.sweep()).toBe(1);
    expect(reg.size).toBe(1);
  });
});
