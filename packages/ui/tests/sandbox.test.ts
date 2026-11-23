import { expect, test } from "bun:test";
import type { JobAttempt } from "../src/api/types";
import { dayLabel, formatMinutes, sandboxInfo } from "../src/lib/sandbox";

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
