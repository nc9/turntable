import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../db";
import { POLICY_USAGE, setPolicy, showPolicy } from "./policy-cli";

export async function policyCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { org: { type: "string" }, "data-dir": { type: "string", default: "./data" } },
    allowPositionals: true,
    strict: true,
  });
  const [sub, key, value] = positionals;
  if (!values.org || (sub !== "show" && sub !== "set")) {
    console.error(POLICY_USAGE);
    process.exit(2);
  }
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  try {
    if (sub === "show") {
      const p = await showPolicy(db, values.org);
      console.log(`approve-run-min-role: ${p.approveRunMinRole}`);
    } else {
      if (!key || !value) throw new Error(POLICY_USAGE);
      const r = await setPolicy(db, values.org, key, value);
      console.error(`${r.key}: ${r.from} -> ${r.to}`);
    }
  } finally {
    db.close();
  }
}
