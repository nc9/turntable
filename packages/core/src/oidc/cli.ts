// `longshore oidc status|rotate|export`: operator control of an org's issuer keys. Local access
// to the data directory and the master key is the trust root, as for `longshore secret`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureInstance, getOrgBySlug, openDatabase } from "../db";
import { loadMasterKey } from "../secrets/crypto";
import { OidcIssuer } from "./issuer";

const USAGE = `usage:
  longshore oidc status --org <slug>
  longshore oidc rotate --org <slug>
  longshore oidc export --org <slug> --base-url <https://host/oidc> --out <dir>
Needs LONGSHORE_MASTER_KEY_FILE (or --master-key-file). The issuer URL of an org is
<base url>/<org slug>. export writes <dir>/<org>/.well-known/openid-configuration and
<dir>/<org>/jwks.json for static hosting: serve them at the issuer URL, and run the server with
LONGSHORE_OIDC_BASE_URL set to the same base so the tokens' iss matches. Re-export after rotate.`;

export async function oidcCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!["status", "rotate", "export"].includes(sub ?? "")) {
    console.error(USAGE);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      "base-url": { type: "string" },
      out: { type: "string" },
      "master-key-file": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  const keyFile = values["master-key-file"] ?? process.env.LONGSHORE_MASTER_KEY_FILE;
  if (!keyFile) throw new Error("set LONGSHORE_MASTER_KEY_FILE or pass --master-key-file");
  if (!values.org) throw new Error("--org <slug> is required");
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  try {
    await ensureInstance(db);
    const org = await getOrgBySlug(db, values.org);
    if (!org) throw new Error(`no org with slug ${values.org}`);
    const base =
      values["base-url"] ?? process.env.LONGSHORE_OIDC_BASE_URL ?? "https://example.invalid/oidc";
    const issuer = new OidcIssuer({ db, masterKey: loadMasterKey(keyFile), baseUrl: base });
    if (sub === "rotate") {
      const r = await issuer.keys.rotate(org.id);
      console.log(
        `${org.slug}: new key ${r.kid}; retired ${r.retired.join(", ") || "none"} (kept in the JWKS for about 15 minutes)`,
      );
      return 0;
    }
    if (sub === "status") {
      for (const k of await issuer.keys.published(org.id)) {
        console.log(
          `${org.slug}: ${k.kid} ${k.rotatedOutAt === undefined ? "current" : `retired ${new Date(k.rotatedOutAt).toISOString()}`}`,
        );
      }
      return 0;
    }
    if (!values.out || !values["base-url"]) throw new Error("--base-url and --out are required");
    const dir = join(resolve(values.out), org.slug);
    mkdirSync(join(dir, ".well-known"), { recursive: true });
    writeFileSync(
      join(dir, ".well-known", "openid-configuration"),
      `${JSON.stringify(issuer.discovery(org.slug), null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "jwks.json"),
      `${JSON.stringify(await issuer.keys.jwks(org.id), null, 2)}\n`,
    );
    console.log(`${org.slug}: wrote ${dir} (issuer ${issuer.issuerUrl(org.slug)})`);
    return 0;
  } finally {
    db.close();
  }
}
