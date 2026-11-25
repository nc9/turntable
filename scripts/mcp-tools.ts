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
    if (JSON.stringify(JSON.parse(cur || "null")) !== JSON.stringify(JSON.parse(next))) {
      console.error("docs/mcp-tools.json is stale: run bun run scripts/mcp-tools.ts --write");
      process.exit(1);
    }
    console.log("docs/mcp-tools.json is current");
  } else {
    writeFileSync(path, next);
    console.log("wrote docs/mcp-tools.json");
  }
}
