import { describe, expect, test } from "bun:test";
import { missingTool, missingToolNotice } from "../src/missing-tool";

describe("missingTool", () => {
  test.each([
    ["bash: line 3: pwsh: command not found", "pwsh"],
    ["/home/runner/work/_temp/abc.sh: line 2: jq: command not found\n", "jq"],
    ["sh: 1: gh: not found", "gh"],
    ["/tmp/step.sh: 4: terraform: not found\n", "terraform"],
    ["env: 'python': No such file or directory", "python"],
    // act's own message for a `shell:` that is not on PATH (no shim stands in for it)
    ["Cannot find: pwsh in PATH\n", "pwsh"],
    ["::group::Run\nCannot find: dotnet in PATH\nError: exit 1", "dotnet"],
    ["building...\nbash: line 1: dotnet: command not found\nmore output after", "dotnet"],
  ])("finds the tool in %j", (text, tool) => {
    expect(missingTool(text)).toBe(tool);
  });

  test.each([
    "",
    "everything fine",
    "error: file not found in cache",
    "cat: nope.txt: No such file or directory",
    "git: 'frobnicate' is not a git command",
    "Cannot find: something else entirely",
  ])("finds nothing in %j", (text) => {
    expect(missingTool(text)).toBeUndefined();
  });

  test("the notice names the tool and points at the list", () => {
    expect(missingToolNotice("pwsh")).toContain("pwsh is not available on this image");
    expect(missingToolNotice("pwsh")).toContain("compatibility");
  });
});
