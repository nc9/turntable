import { describe, expect, test } from "bun:test";
import { fetchUsage, formatUsage, type UsageView } from "../src/usage/cli";

const day = (d: string, min: number, attempts: number, est = 0) => ({
  day: d,
  sandbox_seconds: min * 60,
  sandbox_minutes: min,
  attempts,
  estimated_attempts: est,
});
const view: UsageView = {
  days: [day("2026-11-22", 90, 3, 1)],
  total_seconds: 5400,
  total_minutes: 90,
  projects: [
    {
      project_slug: "app",
      project_name: "App",
      days: [day("2026-11-22", 60, 2)],
      total_seconds: 3600,
      total_minutes: 60,
    },
    {
      project_slug: "site",
      project_name: "Site",
      days: [day("2026-11-22", 30, 1, 1)],
      total_seconds: 1800,
      total_minutes: 30,
    },
  ],
};

describe("longshore usage", () => {
  test("formats the org days, the total and each project", () => {
    const text = formatUsage(view);
    expect(text).toContain("2026-11-22");
    expect(text).toContain("90.0 min");
    expect(text).toContain("(1 estimated)");
    expect(text).toContain("app (App)");
    expect(text).toContain("site (Site)");
  });

  test("asks for days and group_by on the usage path with a bearer token", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const fetchStub = (async (u: URL | string, init?: RequestInit) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get("authorization") };
      return new Response(JSON.stringify(view), { status: 200 });
    }) as never;
    const out = await fetchUsage({
      baseUrl: new URL("https://ci.example.test"),
      token: "tok",
      days: 3,
      byProject: true,
      fetch: fetchStub,
    });
    expect(out.projects).toHaveLength(2);
    const s = seen as unknown as { url: string; auth: string };
    expect(s.auth).toBe("Bearer tok");
    expect(new URL(s.url).pathname).toBe("/api/v1/usage/sandbox");
    expect(new URL(s.url).searchParams.get("days")).toBe("3");
    expect(new URL(s.url).searchParams.get("group_by")).toBe("project");
  });

  test("an error response throws its message", async () => {
    const fetchStub = (async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), { status: 403 })) as never;
    await expect(
      fetchUsage({ baseUrl: new URL("https://ci.example.test"), token: "t", fetch: fetchStub }),
    ).rejects.toThrow("nope");
  });
});
