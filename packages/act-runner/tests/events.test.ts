import { describe, expect, test } from "bun:test";
import { createActParser, summarize, type ActEvent } from "../src/events";

const read = (name: string): Promise<string> =>
  Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
const parseAll = (text: string, chunk = Infinity): ActEvent[] => {
  const p = createActParser();
  const out: ActEvent[] = [];
  for (let i = 0; i < text.length; i += Math.min(chunk, text.length)) {
    out.push(...p.push(text.slice(i, i + chunk)));
    if (chunk === Infinity) break;
  }
  out.push(...p.end());
  return out;
};

describe("act --json parser", () => {
  test("success fixture: inferred job start, step starts and ends, durations", async () => {
    const ev = parseAll(await read("success.jsonl"));
    expect(ev[0]).toMatchObject({ type: "job-start", jobId: "hello", inferred: true });
    const ends = ev.filter((e) => e.type === "step-end");
    expect(ends.map((e) => [e.name, e.result])).toEqual([
      ["Set up job", "success"],
      ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "success"],
      ["Say hello", "success"],
      ["Skipped step", "skipped"],
      ["./.github/actions/greet", "success"],
    ]);
    const co = ends.find((e) => e.name.startsWith("actions/checkout"));
    expect(co?.type === "step-end" && co.durationMs).toBeCloseTo(905.564162, 3);
    expect(ev.at(-1)).toMatchObject({ type: "job-end", result: "success" });
  });

  test("step start is paired with its end; skipped step start is not inferred when announced", async () => {
    const ev = parseAll(await read("success.jsonl"));
    const skipped = ev.filter((e) => e.type === "step-start" && e.name === "Skipped step");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ inferred: false });
  });

  test("an end without a start line gets an inferred start first", () => {
    const line = JSON.stringify({
      jobID: "j",
      msg: "  Success - Main x",
      stage: "Main",
      step: "x",
      stepID: ["4"],
      stepResult: "success",
      time: "t",
    });
    const ev = parseAll(line + "\n");
    expect(ev.map((e) => e.type)).toEqual(["job-start", "step-start", "step-end"]);
    expect(ev[1]).toMatchObject({ inferred: true });
  });

  test("raw output, workflow commands and errors are typed", async () => {
    const ev = parseAll(await read("success.jsonl"));
    expect(ev).toContainEqual(
      expect.objectContaining({ type: "output", text: "hello from act\n" }),
    );
    expect(ev).toContainEqual(
      expect.objectContaining({ type: "command", command: "set-output", arg: "hi" }),
    );
    expect(ev).toContainEqual(expect.objectContaining({ type: "command", command: "group" }));
    const bad = parseAll(await read("failure.jsonl"));
    expect(bad).toContainEqual(
      expect.objectContaining({ type: "error", message: "exit status 3" }),
    );
  });

  test("nested composite step keys keep their path", () => {
    const l = JSON.stringify({
      jobID: "j",
      msg: "\u2b50 Run Main inner",
      stage: "Main",
      step: "inner",
      stepID: ["5", "0"],
      time: "t",
    });
    const ev = parseAll(l + "\n");
    expect(ev.at(-1)).toMatchObject({ type: "step-start", stepKey: "5.0" });
  });

  test("failure fixture summarises to a failed job", async () => {
    const s = summarize(parseAll(await read("failure.jsonl")));
    expect(s).toEqual({ started: true, finished: true, result: "failure", failedSteps: ["Boom"] });
  });

  test("byte-by-byte chunking gives identical events; non-JSON lines become text events", async () => {
    const text = (await read("success.jsonl")) + "not json\n\n";
    expect(parseAll(text, 7)).toEqual(parseAll(text));
  });

  test("no events means not started (skipped job)", () => {
    expect(summarize([])).toEqual({ started: false, finished: false, failedSteps: [] });
  });
});
