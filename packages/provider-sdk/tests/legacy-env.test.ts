// The product's settings were LONGSHORE_* before the rename (formerly Longshore). Neither spelling
// may reach a child process.
import { expect, test } from "bun:test";
import { scrubbedEnv } from "../src/scrubbed-env";

test("neither spelling of a product setting is passed to a child, by name or from the source", () => {
  for (const name of ["TURNTABLE_HOST", "LONGSHORE_HOST"]) {
    expect(() => scrubbedEnv({ [name]: "x" })).toThrow(/refusing/);
    expect(() => scrubbedEnv({}, [name])).toThrow(/refusing/);
  }
  const out = scrubbedEnv({}, [], { PATH: "/bin", TURNTABLE_X: "1", LONGSHORE_X: "1" });
  expect(Object.keys(out)).toEqual(["PATH"]);
});
