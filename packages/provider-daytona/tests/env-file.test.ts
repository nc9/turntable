import { expect, test } from "bun:test";
import { readEnvFileVar } from "../scripts/env-file";

test("reads plain, exported and quoted values and ignores everything else", () => {
  const file = [
    "# comment",
    "OTHER=nope",
    "export DAYTONA_API_KEY='abc-123'",
    "",
    "NOT_DAYTONA_API_KEY=zzz",
  ].join("\n");
  expect(readEnvFileVar(file, "DAYTONA_API_KEY")).toBe("abc-123");
  expect(readEnvFileVar("DAYTONA_API_KEY=plain # trailing", "DAYTONA_API_KEY")).toBe("plain");
  expect(readEnvFileVar('export DAYTONA_API_KEY="q q"', "DAYTONA_API_KEY")).toBe("q q");
  expect(readEnvFileVar("DAYTONA_API_KEY=", "DAYTONA_API_KEY")).toBeUndefined();
  expect(readEnvFileVar("X=1", "DAYTONA_API_KEY")).toBeUndefined();
});
