import { expect, test } from "bun:test";
import type { JobAttempt } from "../src/api/types";
import type { SandboxUsage } from "../src/api/types";
import { dayLabel, formatMinutes, sandboxInfo, usageFor } from "../src/lib/sandbox";

const base: JobAttempt = {
  id: "a",
  orgId: "o",
  projectId: "p",
  jobId: "j",
  attempt: 1,
  state: "success",
  provider: "docker",
  sandboxId: null,
  exitCode: 0,
  errorClass: null,
  createdAt: 0,
  startedAt: 1000,
  finishedAt: 61_000,
  sandboxCreatedAt: 1000,
  sandboxDestroyedAt: 62_500,
  sandboxSeconds: 61.5,
};

test("a confirmed destroy uses the server's exact seconds, never an estimate", () => {
  expect(sandboxInfo(base, 999_999)).toEqual({
    createdAt: 1000,
    destroyedAt: 62_500,
    seconds: 61.5,
    estimated: false,
  });
});

test("no confirmed destroy: estimate to the finish, or to now while running, and flag it", () => {
  const done = sandboxInfo({ ...base, sandboxDestroyedAt: null, sandboxSeconds: null }, 999_999)!;
  expect([done.seconds, done.estimated, done.destroyedAt]).toEqual([60, true, null]);
  const live = sandboxInfo(
    { ...base, finishedAt: null, sandboxDestroyedAt: null, sandboxSeconds: null },
    11_000,
  )!;
  expect([live.seconds, live.estimated]).toEqual([10, true]);
});

test("no sandbox, no info", () => {
  expect(sandboxInfo({ ...base, sandboxCreatedAt: null }, 0)).toBeNull();
});

test("labels", () => {
  expect(dayLabel("2026-11-22")).toBe("Nov 22");
  expect(formatMinutes(3.46)).toBe("3.5 min");
  expect(formatMinutes(245.4)).toBe("245 min");
});

const day = (d: string, minutes: number) => ({
  day: d,
  seconds: minutes * 60,
  minutes,
  attempts: 1,
  estimatedAttempts: 0,
});
const usage: SandboxUsage = {
  days: [day("2026-11-21", 5), day("2026-11-22", 7)],
  totalMinutes: 12,
  limitMinutesPerDay: null,
  projects: [
    {
      id: "p1",
      slug: "api",
      name: "API",
      days: [day("2026-11-21", 5), day("2026-11-22", 4)],
      totalMinutes: 9,
    },
    {
      id: "p2",
      slug: "web",
      name: "Web",
      days: [day("2026-11-21", 0), day("2026-11-22", 3)],
      totalMinutes: 3,
    },
  ],
};

test("usageFor: no filter is the org, a slug is that project, and the projects add up", () => {
  expect(usageFor(usage, null)).toEqual({ days: usage.days, totalMinutes: 12 });
  expect(usageFor(usage, "web").totalMinutes).toBe(3);
  expect(usageFor(usage, "api").days.map((d) => d.minutes)).toEqual([5, 4]);
  expect(usage.projects.reduce((n, p) => n + p.totalMinutes, 0)).toBe(usage.totalMinutes);
});

test("usageFor: a project with no usage in the window shows zeros, never the org's days", () => {
  const u = usageFor(usage, "infra");
  expect(u.totalMinutes).toBe(0);
  expect(u.days.map((d) => [d.day, d.minutes])).toEqual([
    ["2026-11-21", 0],
    ["2026-11-22", 0],
  ]);
});
