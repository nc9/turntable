import { expect, test } from "bun:test";
import { registry } from "../src/ops";

// Edit this list only after review. Every entry gives up the dispatcher's atomic op + audit row.
const ALLOWED_OUTSIDE_TRANSACTION = [
  "db_backup", // cannot run inside a transaction
  "resync_installation", // makes GitHub API calls, which must not hold the write transaction
  "run_dispatch", // forge round trips (resolve the ref, read the workflow) must not hold the write transaction; its writes are one inner transaction
];

test("only allowlisted ops run outside the dispatcher's transaction", () => {
  const actual = registry.ops
    .filter((op) => op.outsideTransaction)
    .map((op) => op.name)
    .sort();
  expect(
    actual,
    [
      "The set of ops with outsideTransaction: true changed.",
      "An op with this flag runs without the dispatcher's write transaction, so its audit row is",
      "written afterwards in a separate transaction: the op and its audit row are no longer atomic,",
      "and if the handler fails part way, its partial effects stay committed with no rollback.",
      "Only add an op here if it cannot run inside a transaction (like db_backup) and a reviewer",
      "has accepted that trade. Otherwise remove outsideTransaction from the op.",
    ].join("\n"),
  ).toEqual(ALLOWED_OUTSIDE_TRANSACTION);
});
