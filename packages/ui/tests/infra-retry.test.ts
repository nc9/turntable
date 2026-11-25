// The run and job pages promise an automatic retry only for infra errors that are retried.
import { describe, expect, test } from "bun:test";
import { retriedAutomatically } from "../src/features/runs/infra-retry";

describe("retry wording", () => {
  test("a refused checkout is not retried; other infra errors are", () => {
    expect(
      retriedAutomatically({
        errorClass:
          "the checkout was refused by GitHub (HTTP 401): check that the Turntable CI App installation can read this repository",
      }),
    ).toBe(false);
    expect(retriedAutomatically({ errorClass: "sandbox_create_failed" })).toBe(true);
    expect(retriedAutomatically({ errorClass: null })).toBe(true);
  });
});
