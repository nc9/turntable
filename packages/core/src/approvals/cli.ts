// `turntable approvals`: the local trust root for human approvals. The first approver can only
// come from here (nobody is enrolled to approve an enrolment yet), and policy is set here. Key
// creation and signing run on the approver's own machine and never touch the server.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../db";
import {
  ApprovalConflict,
  getOrgBySlug,
  getKeyPolicy,
  listApprovers,
  listEnvPolicies,
} from "../db/repos";
import { setAmbientSettings } from "../settings/ambient";
import { loadSettingsRuntime } from "../settings/boot";
import {
  approvalWarnings,
  bootstrapFirstApprover,
  revokeApproverNotifying,
  setKeyPolicyBootstrap,
} from "./apply";
import { changeEnvPolicy } from "./policy-change";
import { MAX_REQUIRED_APPROVALS } from "./policy-setting";
import { notCountingReason } from "./identity";
import { KeyPolicyError, keyPolicyViolation } from "./key-policy";
import { generateEd25519, signEd25519 } from "./keys";

export const APPROVALS_USAGE = `Usage:
  turntable approvals keygen --out <private-key-file>
      Makes an ed25519 approver key. The private key is written (mode 0600) to the file and never
      leaves it; the public key is printed. Run it on the machine that will hold the key.
  turntable approvals bootstrap --org <slug> --person <name> --forge-login <login> --public-key <file|text>
      Enrols the FIRST approver of an org. Refused once any approver exists: after that, new keys
      need a quorum of existing approvers (request_enrolment / approve_enrolment).
  turntable approvals sign --key <private-key-file> --statement <file|->
      Signs the "canonical" text of an approval statement (from approval_challenge) offline.
      Prints the signature object to send with the statement.
  turntable approvals policy --org <slug> --environment <name> --required <n> [--allow-author-approval] [--key-policy any|hardware]
      Sets how many distinct people an environment needs. Without --allow-author-approval the
      author of a run cannot approve it. Allowing it removes the two-person guarantee for that
      environment: use it only for a solo setup. This writes the \`approval_policy\` setting, so it
      is refused while the environment or turntable.toml (--config, TURNTABLE_CONFIG) sets it.
  turntable approvals key-policy --org <slug> --policy any|hardware [--preset yubikey] [--aaguid <uuid>]
      Bootstrap only: works while the org has no approver. Afterwards a change needs a statement
      signed by a quorum of the counted approvers (key_policy_challenge and approve_key_policy).
      Which keys approvers may use. hardware accepts only passkeys whose attestation chained to a
      pinned vendor root at enrolment and whose AAGUID is on the allowlist (security keys; Touch ID
      and Face ID passkeys give no attestation). Keys that do not satisfy it stop counting.
  turntable approvals list --org <slug>
  turntable approvals revoke --org <slug> --id <approver id>
All but keygen and sign take --data-dir (default ./data).`;

const read = (v: string): string => (existsSync(v) ? readFileSync(v, "utf8") : v);

export async function approvalsCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      key: { type: "string" },
      statement: { type: "string" },
      org: { type: "string" },
      person: { type: "string" },
      policy: { type: "string" },
      preset: { type: "string", multiple: true },
      aaguid: { type: "string", multiple: true },
      "forge-login": { type: "string" },
      "public-key": { type: "string" },
      environment: { type: "string" },
      required: { type: "string" },
      "allow-author-approval": { type: "boolean", default: false },
      "key-policy": { type: "string" },
      config: { type: "string" },
      id: { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  const usage = (): number => {
    console.error(APPROVALS_USAGE);
    return 2;
  };

  if (sub === "keygen") {
    if (!values.out) return usage();
    if (existsSync(values.out)) {
      console.error(`${values.out} already exists; refusing to overwrite a key`);
      return 1;
    }
    const k = generateEd25519();
    writeFileSync(values.out, k.privatePem, { mode: 0o600 });
    chmodSync(values.out, 0o600);
    console.error(`private key written to ${values.out}. Keep it off the server.`);
    console.log(k.publicSpki);
    return 0;
  }
  if (sub === "sign") {
    if (!values.key || !values.statement) return usage();
    const text = values.statement === "-" ? await Bun.stdin.text() : read(values.statement);
    // Accepts the approval_challenge response, a bare { canonical }, or the canonical text itself.
    let canonical = text.trim();
    try {
      const j = JSON.parse(text) as { canonical?: unknown };
      if (typeof j.canonical === "string") canonical = j.canonical;
    } catch {
      // not JSON: the text is the canonical statement
    }
    // Show what is being signed, so the signer sees the identity an enrolment would grant.
    try {
      const st = JSON.parse(canonical) as Record<string, unknown>;
      const fields = [
        "type",
        "person",
        "forge_login",
        "run_id",
        "environment",
        "trust_class",
        "enrolment_id",
      ];
      console.error(
        `signing: ${fields
          .filter((f) => typeof st[f] === "string")
          .map((f) => `${f}=${String(st[f])}`)
          .join(" ")}`,
      );
    } catch {
      // not JSON: nothing to summarise
    }
    const sig = signEd25519(readFileSync(values.key, "utf8"), canonical);
    console.log(JSON.stringify({ kind: "ed25519", signature: sig }));
    return 0;
  }

  if (!values.org || !["bootstrap", "policy", "key-policy", "list", "revoke"].includes(sub ?? ""))
    return usage();
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    const org = await getOrgBySlug(db, values.org);
    if (!org) {
      console.error(`no such org: ${values.org}`);
      return 1;
    }
    const now = Date.now();
    // The policy is a setting: the environment and turntable.toml (--config) lock it, here as in
    // the server, and the warnings below read it the way the engine does.
    setAmbientSettings(loadSettingsRuntime({ config: values.config }));
    if (sub === "bootstrap") {
      if (!values.person || !values["public-key"] || !values["forge-login"]) return usage();
      let a: { id: string; person: string };
      try {
        a = await bootstrapFirstApprover(
          db,
          org.id,
          {
            person: values.person,
            forgeLogin: values["forge-login"],
            publicKey: read(values["public-key"]),
            createdBy: "cli:bootstrap",
          },
          now,
        );
      } catch (e) {
        if (!(e instanceof ApprovalConflict)) throw e;
        console.error(e.message);
        return 1;
      }
      for (const w of await approvalWarnings(db, org.id, ["production", "release"]))
        console.error(`warning: ${w}`);
      console.log(JSON.stringify({ approver_id: a.id, person: a.person }));
      return 0;
    }
    if (sub === "policy") {
      const n = Number(values.required);
      const kp = values["key-policy"];
      if (!values.environment || !Number.isInteger(n) || n < 1 || n > MAX_REQUIRED_APPROVALS)
        return usage();
      if (kp !== undefined && kp !== "any" && kp !== "hardware") return usage();
      let loosened: string[];
      try {
        ({ loosened } = await changeEnvPolicy(db, org, {
          environment: values.environment,
          required: n,
          allowAuthorApproval: values["allow-author-approval"],
          ...(kp ? { keyPolicy: kp } : {}),
          now,
        }));
      } catch (e) {
        if (e instanceof ApprovalConflict) {
          console.error(e.message);
          return 1;
        }
        throw e;
      }
      for (const l of loosened) console.error(`warning: ${l}`);
      if (values["allow-author-approval"])
        console.error(
          `warning: the author of a run can approve it in ${values.environment}. This is for solo setups only.`,
        );
      console.log(JSON.stringify({ environment: values.environment, required: n }));
      return 0;
    }
    if (sub === "key-policy") {
      if (values.policy !== "any" && values.policy !== "hardware") return usage();
      try {
        const next = await setKeyPolicyBootstrap(
          db,
          org.id,
          { mode: values.policy, presets: values.preset ?? [], aaguids: values.aaguid ?? [] },
          now,
        );
        console.log(JSON.stringify(next));
        return 0;
      } catch (e) {
        if (e instanceof KeyPolicyError) {
          console.error(e.message);
          return 1;
        }
        throw e;
      }
    }
    if (sub === "list") {
      const keyPolicy = await getKeyPolicy(db, org.id);
      console.log(
        JSON.stringify(
          {
            approvers: (await listApprovers(db, org.id)).map((a) => ({
              id: a.id,
              person: a.person,
              kind: a.kind,
              forge_login: a.forgeLogin,
              attested: a.attested,
              aaguid: a.aaguid,
              not_counting: notCountingReason(a) ?? keyPolicyViolation(keyPolicy, a),
            })),
            key_policy: keyPolicy,
            warnings: await approvalWarnings(db, org.id, [
              "production",
              "release",
              ...(await listEnvPolicies(db, org.id)).map((p) => p.environment),
            ]),
            policies: (await listEnvPolicies(db, org.id)).map((p) => ({
              environment: p.environment,
              required: p.required,
              allow_author_approval: p.allowAuthorApproval,
              key_policy: p.keyPolicy,
              locked: p.locked,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (!values.id) return usage();
    const done = await revokeApproverNotifying(db, org, values.id, now, {
      kind: "cli",
      id: "local",
    });
    console.log(JSON.stringify({ revoked: done }));
    return done ? 0 : 1;
  } finally {
    db.close();
  }
}
