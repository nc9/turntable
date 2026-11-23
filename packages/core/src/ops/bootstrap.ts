// First-boot access without a shell. The image is distroless, so `token create` cannot run
// inside it. The operator generates a token locally (`turntable token generate`), keeps it, and
// sets only its sha256 as TURNTABLE_BOOTSTRAP_TOKEN_SHA256. On boot, an org with no tokens gets
// one operator token row with that hash. The secret never touches the environment or the logs.
import type { Db } from "../db";
import {
  appendAudit,
  createOrg,
  ensureLocalTenant,
  getOrgBySlug,
  insertApiToken,
  listApiTokens,
} from "../db/repos";

const DAY_MS = 86_400_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type BootstrapResult =
  | { status: "created"; org: string; tokenId: string; expiresAt: number }
  | { status: "skipped"; org: string; reason: "org already has tokens" };

export async function bootstrapToken(
  db: Db,
  opts: { sha256: string; org?: string | undefined; now?: (() => number) | undefined },
): Promise<BootstrapResult> {
  const hash = opts.sha256.trim().toLowerCase();
  if (!SHA256_HEX.test(hash)) {
    throw new Error("TURNTABLE_BOOTSTRAP_TOKEN_SHA256 must be 64 hex characters (a sha256)");
  }
  const slug = (opts.org ?? "local").trim() || "local";
  if (!ORG_SLUG.test(slug)) throw new Error(`invalid bootstrap org slug: ${JSON.stringify(slug)}`);

  let org = await getOrgBySlug(db, slug);
  if (!org) {
    if (slug === "local") await ensureLocalTenant(db);
    else await createOrg(db, { slug, name: slug });
    org = await getOrgBySlug(db, slug);
  }
  if (!org) throw new Error(`could not create org ${slug}`);
  const scope = { orgId: org.id };
  if ((await listApiTokens(db, scope)).length > 0) {
    return { status: "skipped", org: slug, reason: "org already has tokens" };
  }
  const expiresAt = (opts.now ?? Date.now)() + 365 * DAY_MS;
  const row = await db.transaction(async (tx) => {
    const created = await insertApiToken(tx, scope, {
      name: "bootstrap",
      role: "operator",
      // The operator's own token, held by a person: it may approve under `no_agents`.
      kind: "person",
      tokenHash: hash,
      createdBy: "bootstrap:env",
      expiresAt,
    });
    await appendAudit(tx, scope, {
      principalKind: "bootstrap",
      principalId: "env",
      op: "create_api_token",
      effect: "write",
      outcome: "ok",
      input: {
        name: "bootstrap",
        role: "operator",
        kind: "person",
        org: slug,
        source: "TURNTABLE_BOOTSTRAP_TOKEN_SHA256",
      },
    });
    return created;
  });
  return { status: "created", org: slug, tokenId: row.id, expiresAt };
}
