import { describe, expect, test } from "bun:test";
import {
  BEGIN,
  END,
  parseProbe,
  probeScript,
  renderTable,
  replaceBlock,
  TOOLS,
} from "./runner-toolset";

describe("runner toolset", () => {
  test("the probe script names every tool once", () => {
    const script = probeScript();
    for (const t of TOOLS) expect(script).toContain(`'${t.cmd}'`);
  });

  test("parses present and absent tools", () => {
    const out = "bash\tpresent\tGNU bash, version 5.2\nyq\tabsent\t\nnoise without tabs\n";
    expect(parseProbe(out)).toEqual([
      { cmd: "bash", present: true, version: "GNU bash, version 5.2" },
      { cmd: "yq", present: false, version: "" },
    ]);
  });

  test("the table keeps the tool order, marks absent tools, and escapes table characters", () => {
    const table = renderTable(
      [
        { cmd: "bash", present: true, version: "5.2 | odd {x}" },
        { cmd: "yq", present: false, version: "" },
      ],
      [
        { name: "bash", cmd: "bash", version: ["--version"], github: true },
        { name: "yq", cmd: "yq", version: ["--version"], github: true },
        { name: "tool", cmd: "tool", version: ["-v"], github: false, note: "Why." },
      ],
    );
    const lines = table.split("\n");
    expect(lines[0]).toContain("Tool");
    expect(lines[2]).toBe("| bash | Yes | Yes: 5.2 \\| odd &#123;x} |");
    expect(lines[3]).toBe("| yq | Yes | No |");
    expect(lines[4]).toBe("| tool | No | No. Why. |");
  });

  test("replaces only the generated block and needs the markers", () => {
    const doc = `before\n${BEGIN}\n\nold\n\n${END}\nafter\n`;
    const next = replaceBlock(doc, "NEW");
    expect(next).toContain("before");
    expect(next).toContain("after");
    expect(next).toContain("NEW");
    expect(next).not.toContain("old");
    expect(replaceBlock(next, "NEW")).toBe(next);
    expect(() => replaceBlock("no markers", "x")).toThrow();
  });
});
