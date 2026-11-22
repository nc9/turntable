import { expect, test } from "bun:test";
import { capExcerpt, pickExcerpt } from "../src/ops/failure-digest";

const E = "\u001b[";
const text = (r: { lines: string[] }) => r.lines.join("\n");

// Bun's shape: pass lines, then `✗ suite > name [ms]` followed by expected/received and a frame.
const BUN = [
  "bun test v1.4.5",
  "",
  "tests/paths.test.ts:",
  `${E}32m✓${E}0m paths > throws error for invalid path [0.31ms]`,
  `${E}32m✓${E}0m paths > returns an error code on missing file [0.12ms]`,
  `${E}32m✓${E}0m paths > handles error events [0.09ms]`,
  `${E}31m✗${E}0m tenancy > rejects cross-org lookups [1.20ms]`,
  "  expect(received).toBeUndefined()",
  "",
  '  Received: {"id":"01J"}',
  "",
  "      at <anonymous> (/repo/tests/tenancy.test.ts:88:14)",
  `${E}32m✓${E}0m queue > retries on error [0.40ms]`,
  `${E}31m✗${E}0m queue > second failing test [0.50ms]`,
  "",
  " 60 pass",
  " 2 fail",
].join("\n");

test("bun: the first ✗ line wins over passing tests whose names contain 'error'", () => {
  const r = pickExcerpt(BUN);
  expect(r.basis).toBe("failure_marker");
  const t = text(r);
  expect(t).toContain("✗ tenancy > rejects cross-org lookups");
  expect(t).toContain("Received:");
  expect(t).toContain("at <anonymous> (/repo/tests/tenancy.test.ts:88:14)");
  expect(t).not.toContain("throws error for invalid path");
  expect(t).not.toContain("\u001b");
  // Stops at the next pass line.
  expect(t).not.toContain("retries on error");
});

test("bun (fail) marker and an assertion printed before the marker", () => {
  const log = [
    "tests/a.test.ts:",
    "(pass) a > one [0.1ms]",
    "error: expect(received).toBe(expected)",
    "Expected: 2",
    "Received: 1",
    "      at <anonymous> (/repo/tests/a.test.ts:5:12)",
    "(fail) a > two [0.3ms]",
    "(pass) a > error case [0.1ms]",
  ].join("\n");
  const r = pickExcerpt(log);
  expect(r.basis).toBe("failure_marker");
  expect(text(r)).toContain("(fail) a > two");
  expect(text(r)).toContain("at <anonymous> (/repo/tests/a.test.ts:5:12)");
  expect(text(r)).not.toContain("error case");
});

test("jest, vitest, pytest, go and tap markers", () => {
  const cases: [string, string][] = [
    [
      "  ✓ handles an error\n  ✕ adds numbers (3 ms)\n\n    expect(received).toBe(expected)\n\n    Expected: 3",
      "✕ adds numbers",
    ],
    [
      "PASS src/error.test.ts\nFAIL src/math.test.ts\n  ● adds\n    expected 3",
      "FAIL src/math.test.ts",
    ],
    [
      "tests/test_x.py .F\n=== short test summary info ===\nFAILED tests/test_x.py::test_add - assert 2 == 3",
      "FAILED tests/test_x.py::test_add",
    ],
    [
      "--- PASS: TestError (0.00s)\n--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 2, want 3\nFAIL",
      "--- FAIL: TestAdd",
    ],
    ["ok 1 - error handling\nnot ok 2 - adds\n  ---\n  expected: 3\n  ...", "not ok 2 - adds"],
  ];
  for (const [log, want] of cases) {
    const r = pickExcerpt(log);
    expect(r.basis).toBe("failure_marker");
    expect(text(r)).toContain(want);
    expect(text(r)).not.toContain("handles an error");
  }
});

test("a failure marker beats an ::error annotation", () => {
  const r = pickExcerpt("::error::generic wrapper failure\n✗ suite > case [1ms]\nexpected 1");
  expect(r.basis).toBe("failure_marker");
  expect(text(r)).toContain("suite > case");
});

test("without markers: annotation, then non-pass keyword lines, then the tail", () => {
  expect(pickExcerpt("a\n::error file=x.ts::boom\nb").basis).toBe("annotation");
  const kw = pickExcerpt(
    [
      "✓ throws error for invalid path",
      "(pass) error handling",
      "ok  error pkg",
      "building",
      "error: cannot find module 'x'",
    ].join("\n"),
  );
  expect(kw.basis).toBe("error_pattern");
  expect(text(kw)).toContain("error: cannot find module 'x'");
  // A log whose only keyword lines are passes has no error line at all.
  const onlyPass = pickExcerpt(["✓ throws error", "(pass) error handling", "done"].join("\n"));
  expect(onlyPass.basis).toBe("tail");
});

test("the excerpt is capped on a line boundary", () => {
  const long = [
    "✗ big",
    ...Array.from({ length: 14 }, (_, i) => `line ${i} ${"x".repeat(300)}`),
  ].join("\n");
  const r = pickExcerpt(long);
  const c = capExcerpt(text(r));
  expect(c.truncated).toBe(true);
  expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(2048);
});
