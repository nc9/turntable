import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../db";
import { policyCommand as actionPolicyCommand } from "../pins/cli";
import {
  POLICY_USAGE,
  setChecksModePolicy,
  setSigningPolicy,
  showChecksMode,
  showSigning,
  setEgressPolicy,
  setPolicy,
  showEgress,
  showPolicy,
} from "./policy-cli";

async function ownPolicy(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      org: { type: "string", default: "local" },
      project: { type: "string" },
      egress: { type: "string" },
      "checks-mode": { type: "string" },
      "release-refs": { type: "string" },
      "signing-key": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [sub, key, value] = positionals;
  if (sub !== "show" && sub !== "set") {
    console.error(POLICY_USAGE);
    process.exit(2);
  }
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  try {
    if (sub === "show") {
      const p = await showPolicy(db, values.org);
      console.log(`approve-run-min-role: ${p.approveRunMinRole}`);
      for (const e of await showEgress(db, values.org))
        console.log(`egress ${e.project}: ${e.egress}`);
      for (const x of await showSigning(db, values.org)) {
        console.log(
          `signing ${x.project}: release refs ${x.releaseRefs.join(", ")}; key ${x.signingKey ?? "(none)"}`,
        );
      }
      for (const c of await showChecksMode(db, values.org))
        console.log(`checks-mode ${c.project}: ${c.mode}`);
    } else if (values["release-refs"] !== undefined || values["signing-key"] !== undefined) {
      const refs = values["release-refs"];
      for (const r of await setSigningPolicy(db, values.org, values.project, {
        releaseRefs:
          refs === undefined
            ? undefined
            : refs
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
        signingKey: values["signing-key"],
      })) {
        console.error(
          `signing ${r.project}: release refs ${r.releaseRefs.join(", ")}; key ${r.signingKey ?? "(none)"}`,
        );
      }
    } else if (values["checks-mode"] !== undefined) {
      for (const r of await setChecksModePolicy(
        db,
        values.org,
        values.project,
        values["checks-mode"],
      )) {
        console.error(`checks-mode ${r.project}: ${r.from} -> ${r.to}`);
      }
    } else if (values.egress !== undefined) {
      for (const r of await setEgressPolicy(db, values.org, values.project, values.egress)) {
        console.error(`egress ${r.project}: ${r.from} -> ${r.to}`);
      }
    } else {
      if (!key || !value) throw new Error(POLICY_USAGE);
      const r = await setPolicy(db, values.org, key, value);
      console.error(`${r.key}: ${r.from} -> ${r.to}`);
    }
  } finally {
    db.close();
  }
}

/**
 * `longshore policy`: one command for every per-org and per-project policy. Action pinning
 * (`--require-sha-pins`, `--allow-owners`) is handled by the pins module; `approve-run-min-role`
 * and `--egress` here. `show` prints both.
 */
export async function policyCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const ours =
    rest.includes("approve-run-min-role") ||
    rest.some((a) => /^--(egress|checks-mode|release-refs|signing-key)(=|$)/.test(a));
  if (sub === "set" && ours) return ownPolicy(args);
  if (sub === "show") {
    await actionPolicyCommand(args);
    return ownPolicy(args);
  }
  return actionPolicyCommand(args);
}
