// Writes docs/mcp-tools.json: the MCP tool list (name and input schema, no prose) from the ops
// registry, so CD can diff the agent-facing tool surface between two commits with `git show`.
// CI runs `--check` (compared as parsed JSON, so the formatter's whitespace cannot flap it); a
// developer runs `--write`, then `bun fmt` on the file.
//
//   bun run scripts/mcp-tools.ts [--write | --check]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "../packages/core/src/ops";
import { mcpTools } from "../packages/core/src/ops/mcp";

export function renderMcpTools(): string {
  const list = mcpTools(registry)
    .map((t) => ({ name: t.name, inputSchema: t.inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `${JSON.stringify(list, null, 2)}\n`;
}

type ToolEntry = { name: string; inputSchema: unknown };

function parseList(text: string): ToolEntry[] {
  if (text.trim() === "") return [];
  return JSON.parse(text) as ToolEntry[];
}

/** Lines describing how the committed list differs from the generated one; empty when equal. */
export function diffMcpTools(committed: string, generated: string): string[] {
  let cur: ToolEntry[];
  try {
    cur = parseList(committed);
  } catch {
    return ["docs/mcp-tools.json is not valid JSON"];
  }
  const next = parseList(generated);
  const curByName = new Map(cur.map((t) => [t.name, JSON.stringify(t.inputSchema)]));
  const nextByName = new Map(next.map((t) => [t.name, JSON.stringify(t.inputSchema)]));
  const out: string[] = [];
  for (const [name, schema] of nextByName) {
    if (!curByName.has(name)) out.push(`missing from the file: ${name}`);
    else if (curByName.get(name) !== schema) out.push(`input schema changed: ${name}`);
  }
  for (const name of curByName.keys()) {
    if (!nextByName.has(name)) out.push(`no longer a tool: ${name}`);
  }
  if (out.length === 0 && JSON.stringify(cur) !== JSON.stringify(next))
    out.push("tool order differs");
  return out;
}

if (import.meta.main) {
  const path = join(import.meta.dir, "../docs/mcp-tools.json");
  const next = renderMcpTools();
  if (process.argv.includes("--check")) {
    const cur = (() => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    })();
    const diff = diffMcpTools(cur, next);
    if (diff.length > 0) {
      console.error(`docs/mcp-tools.json is stale (${diff.length} difference(s)):`);
      for (const line of diff) console.error(`  ${line}`);
      console.error("run: bun run scripts/mcp-tools.ts --write && bun fmt docs/mcp-tools.json");
      process.exit(1);
    }
    console.log("docs/mcp-tools.json is current");
  } else {
    writeFileSync(path, next);
    console.log("wrote docs/mcp-tools.json");
  }
}
