import { expect, test } from "bun:test";
import type { ActEvent } from "@turntable/act-runner";
import { MissingToolWatch } from "../src/run/job-exec";

const time = "2026-01-01T00:00:00Z";
const out = (text: string, stepKey = "1"): ActEvent => ({
  type: "output",
  jobId: "j",
  stepKey,
  text,
  time,
});
const end = (result: string, stepKey = "1"): ActEvent => ({
  type: "step-end",
  jobId: "j",
  stepKey,
  name: "s",
  stage: "Main",
  result,
  time,
});
const NOT_FOUND = "bash: line 2: jq: command not found\n";

const feed = (events: ActEvent[]): (string | undefined)[] => {
  const w = new MissingToolWatch();
  return events.map((e) => w.see(e));
};

test("normal order: output then step-end names the tool once", () => {
  expect(feed([out(NOT_FOUND), end("failure")]).filter(Boolean)).toEqual(["jq"]);
});

test("late output: step-end(failure) before output names the tool once", () => {
  expect(feed([end("failure"), out(NOT_FOUND), out("more\n")]).filter(Boolean)).toEqual(["jq"]);
});

test("output split across the step-end still names the tool once", () => {
  const w = new MissingToolWatch();
  const seen = [out("bash: line 2: j"), end("failure"), out("q: command not found\n")].map((e) =>
    w.see(e),
  );
  expect(seen.filter(Boolean)).toEqual(["jq"]);
});

test("a successful step never gets a notice, even with late output", () => {
  expect(feed([out(NOT_FOUND), end("success"), out(NOT_FOUND)]).filter(Boolean)).toEqual([]);
});

test("a repeated step-end after the notice does not repeat it", () => {
  expect(feed([out(NOT_FOUND), end("failure"), end("failure")]).filter(Boolean)).toEqual(["jq"]);
});

test("steps are tracked separately", () => {
  const seen = feed([end("failure", "a"), out(NOT_FOUND, "b"), out(NOT_FOUND, "a")]);
  expect(seen.filter(Boolean)).toEqual(["jq"]);
});

test("the tail stays bounded and clear drops it", () => {
  const w = new MissingToolWatch();
  w.see(end("failure"));
  const big = "x".repeat(20 * 1024);
  expect(w.see(out(big))).toBeUndefined();
  expect(w.see(out(NOT_FOUND))).toBe("jq");
  // The old head fell out of the window: only the last 8 KiB can name a tool.
  const w2 = new MissingToolWatch();
  w2.see(out(NOT_FOUND));
  w2.see(out(big));
  expect(w2.see(end("failure"))).toBeUndefined();
  w.clear();
  expect(w.see(out(NOT_FOUND))).toBeUndefined();
});
