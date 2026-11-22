import { describe, expect, test } from "bun:test";
import { createBackoff, fetchWithBackoff, RateLimitedError, rateLimitDelayMs } from "../src";

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response("x", { status, headers });

describe("rateLimitDelayMs", () => {
  const now = 1_000_000_000_000;
  test("a secondary limit honours retry-after", () => {
    expect(rateLimitDelayMs(res(403, { "retry-after": "7" }), now)).toBe(8000);
    expect(rateLimitDelayMs(res(429, { "retry-after": "0" }), now)).toBe(1000);
  });
  test("a primary limit waits for the reset", () => {
    const reset = String(now / 1000 + 30);
    expect(
      rateLimitDelayMs(res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), now),
    ).toBe(31_000);
  });
  test("a plain 403 or other status is not a rate limit; a bare 429 waits a default", () => {
    expect(rateLimitDelayMs(res(403), now)).toBeUndefined();
    expect(rateLimitDelayMs(res(403, { "x-ratelimit-remaining": "40" }), now)).toBeUndefined();
    expect(rateLimitDelayMs(res(500), now)).toBeUndefined();
    expect(rateLimitDelayMs(res(200), now)).toBeUndefined();
    expect(rateLimitDelayMs(res(429), now)).toBe(10_000);
  });
});

describe("fetchWithBackoff", () => {
  test("backs off, retries and succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const backoff = createBackoff({ sleep: async (ms) => void waits.push(ms), now: () => 0 });
    const out = await fetchWithBackoff(
      async () => (++calls < 3 ? res(403, { "retry-after": "2" }) : res(200)),
      "https://api.github.com/x",
      {},
      backoff,
    );
    expect(out.status).toBe(200);
    expect(waits).toEqual([3000, 3000]);
    expect(backoff.waitedMs).toBe(6000);
  });

  test("gives up past the budget with the reset time, and the budget is shared", async () => {
    const backoff = createBackoff({ budgetMs: 10_000, sleep: async () => {}, now: () => 0 });
    const limited = async () => res(403, { "retry-after": "4" });
    // Each wait is 5s: two fit in the 10s budget, the third does not.
    await expect(fetchWithBackoff(limited, "https://x/", {}, backoff)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(backoff.waitedMs).toBe(10_000);
    // The same budget is spent: another call fails at once.
    await expect(fetchWithBackoff(limited, "https://x/", {}, backoff)).rejects.toThrow(
      /past this job's 10s wait budget/,
    );
  });

  test("a real refusal is returned, not retried", async () => {
    let calls = 0;
    const out = await fetchWithBackoff(
      async () => (calls++, res(403)),
      "https://x/",
      {},
      createBackoff(),
    );
    expect(out.status).toBe(403);
    expect(calls).toBe(1);
  });
});
