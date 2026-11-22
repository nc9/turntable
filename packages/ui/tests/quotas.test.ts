import { describe, expect, test } from "bun:test";
import { createFixture } from "../src/api/fixture/adapter";
import { createHttpApi } from "../src/api/http-adapter";
import type { WireQuotas } from "../src/api/wire";
import { formatBytes, formatQuotaValue, QUOTA_ROWS, quotaLevel } from "../src/lib/quota";

const wire = (over: Partial<WireQuotas["limits"]> = {}): WireQuotas => ({
  limits: {
    max_concurrent: 3,
    max_runs_per_hour: null,
    max_sandbox_minutes_per_day: 600,
    max_log_bytes: null,
    max_stored_bytes: null,
    ...over,
  },
  usage: [
    { metric: "concurrent", used: 1, limit: 3, percent: 33, held: null },
    {
      metric: "sandbox_minutes",
      used: 610,
      limit: 600,
      percent: 101,
      held: "new work is held: sandbox minutes in the last 24 hours reached its limit (610 of 600)",
    },
  ],
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("presentation", () => {
  test("levels follow the thresholds the events fire at", () => {
    const lvl = (limit: number | null, percent: number | null) => quotaLevel({ limit, percent });
    expect(lvl(null, null)).toBe("none");
    expect(lvl(10, 79)).toBe("ok");
    expect(lvl(10, 80)).toBe("warning");
    expect(lvl(10, 99)).toBe("warning");
    expect(lvl(10, 100)).toBe("reached");
    expect(lvl(10, 250)).toBe("reached");
  });

  test("values are formatted per unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(48_000_000)).toBe("48 MB");
    expect(formatBytes(1_200_000_000)).toBe("1.2 GB");
    expect(formatQuotaValue(1234, "count")).toBe("1,234");
    expect(formatQuotaValue(90, "minutes")).toBe("90 min");
  });

  test("every metric the server reports has a row, and each row sets one field", () => {
    expect(QUOTA_ROWS.map((r) => String(r.metric)).toSorted()).toEqual([
      "concurrent",
      "log_bytes",
      "runs_per_hour",
      "sandbox_minutes",
      "stored_bytes",
    ]);
    expect(new Set(QUOTA_ROWS.map((r) => r.field)).size).toBe(QUOTA_ROWS.length);
  });
});

describe("fixture backend", () => {
  test("shows limits and usage, and a limit that is reached is held with its reason", async () => {
    const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "q1" });
    try {
      const q = await fx.api.getQuotas();
      expect(q.limits.maxConcurrent).toBe(4);
      expect(q.usage.map((u) => u.metric)).toContain("sandbox_minutes");
      expect(q.usage.every((u) => u.held === null)).toBe(true);
      expect(q.usage.find((u) => u.metric === "log_bytes")).toMatchObject({
        limit: null,
        percent: null,
      });
      // The API surface has no way to set limits: that is the operator's, on the host.
      expect("setQuotas" in fx.api).toBe(false);
    } finally {
      fx.stop();
    }
  });
});

describe("http adapter", () => {
  test("reads GET /quotas and maps the names; there is no set", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const api = createHttpApi({
      org: () => "acme",
      token: () => "tt_secret",
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input), "http://localhost");
        calls.push({ url, init });
        return json(wire());
      }) as typeof fetch,
    });
    const got = await api.getQuotas();
    expect(calls[0]!.url.pathname).toBe("/api/v1/quotas");
    expect(calls[0]!.url.searchParams.get("org")).toBe("acme");
    expect(got.limits).toMatchObject({
      maxConcurrent: 3,
      maxSandboxMinutesPerDay: 600,
      maxLogBytes: null,
    });
    expect(got.usage[1]!.held).toContain("reached its limit");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer tt_secret",
    );
    expect("setQuotas" in api).toBe(false);
  });

  test("a project-scoped token is refused by the server and the message surfaces", async () => {
    const api = createHttpApi({
      org: () => "acme",
      token: () => "tt_project",
      fetch: (async () =>
        json(
          {
            error: { code: "forbidden", message: "an org-level token is required to read quotas" },
          },
          403,
        )) as unknown as typeof fetch,
    });
    await expect(api.getQuotas()).rejects.toThrow(/org-level token/);
  });
});
