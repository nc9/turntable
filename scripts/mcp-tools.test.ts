import { expect, test } from "bun:test";
import { diffMcpTools, renderMcpTools } from "./mcp-tools";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the committed docs/mcp-tools.json matches the registry", () => {
  const committed = readFileSync(join(import.meta.dir, "../docs/mcp-tools.json"), "utf8");
  expect(diffMcpTools(committed, renderMcpTools())).toEqual([]);
});

test("diffMcpTools names added, removed and changed tools", () => {
  const a = JSON.stringify([
    { name: "a", inputSchema: {} },
    { name: "b", inputSchema: { x: 1 } },
  ]);
  const b = JSON.stringify([
    { name: "b", inputSchema: { x: 2 } },
    { name: "c", inputSchema: {} },
  ]);
  expect(diffMcpTools(a, b)).toEqual([
    "input schema changed: b",
    "missing from the file: c",
    "no longer a tool: a",
  ]);
  expect(diffMcpTools("", a)).toHaveLength(2);
  expect(diffMcpTools(a, a)).toEqual([]);
});
