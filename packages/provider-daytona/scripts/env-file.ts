/**
 * Reads one variable from a shell-style env file (`KEY=value`, `export KEY="value"`) without
 * printing anything. Returns undefined when absent. Comments and other keys are ignored.
 */
export function readEnvFileVar(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    let v = m[2]!.trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    found = v;
  }
  return found === "" ? undefined : found;
}
