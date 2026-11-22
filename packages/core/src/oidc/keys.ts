// Per-org OIDC signing keys. Each org has its own issuer, so each has its own keys: a key that
// signs for one org never signs for another. Private keys are sealed in the `oidc` key domain
// (a different wrapping key from the audit key, the GitHub App and the vault), in the same
// `secrets` table as the other system secrets, one record per key, named `oidc/key/<kid>`.
//
// Rotation keeps the old public key in the JWKS until every token it could have signed has
// expired, so a relying party that fetched the JWKS a minute ago still verifies a token signed a
// minute before the rotation. Records hold everything (private key, times) in one sealed JSON.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";
import type { Db } from "../db";
import {
  appendAudit,
  deleteSecretRecord,
  getSecretRecord,
  listSecretNames,
  putSecretRecord,
} from "../db/repos";
import { open, seal, secretAad } from "../secrets/crypto";

export const OIDC_ALG = "ES256";
export const KEY_PREFIX = "oidc/key/";
/** The longest a token lives, in seconds. Also how long a retired key stays in the JWKS. */
export const MAX_TOKEN_SECONDS = 600;
/** Extra time a retired key stays published, for clock skew and caches. */
export const RETIRED_GRACE_MS = 5 * 60_000;

/** The only members a published JWK may have. Anything else (above all `d`) is a bug. */
export const PUBLIC_JWK_MEMBERS = ["kty", "crv", "x", "y", "kid", "use", "alg"] as const;

interface KeyRecord {
  v: 1;
  kid: string;
  privateKeyPem: string;
  createdAt: number;
  /** When it stopped being the signing key. Absent while it is the current key. */
  rotatedOutAt?: number;
}

export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  use: "sig";
  alg: "ES256";
}

export interface OidcKey {
  kid: string;
  createdAt: number;
  rotatedOutAt?: number;
  jwk: PublicJwk;
}

const nameOf = (kid: string): string => `${KEY_PREFIX}${kid}`;

/** RFC 7638 thumbprint of an EC key: sha256 over the canonical member set. */
function thumbprint(jwk: { crv: string; x: string; y: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: "EC", x: jwk.x, y: jwk.y }))
    .digest("base64url");
}

function publicJwkOf(privateKeyPem: string): PublicJwk {
  const raw = createPublicKey(createPrivateKey(privateKeyPem)).export({
    format: "jwk",
  }) as Record<string, string>;
  // Copy the allowed members only: never spread an exported key into something published.
  const base = { crv: raw.crv as string, x: raw.x as string, y: raw.y as string };
  return {
    kty: "EC",
    crv: "P-256",
    x: base.x,
    y: base.y,
    kid: thumbprint(base),
    use: "sig",
    alg: "ES256",
  };
}

/** Throws if a JWK carries anything beyond the public members. Used before anything is published. */
export function assertPublicJwk(jwk: Record<string, unknown>): void {
  for (const k of Object.keys(jwk)) {
    if (!(PUBLIC_JWK_MEMBERS as readonly string[]).includes(k)) {
      throw new Error(`refusing to publish JWK member "${k}"`);
    }
  }
}

export class OidcKeyStore {
  readonly #db: Db;
  readonly #master: Buffer;

  constructor(db: Db, masterKey: Buffer) {
    this.#db = db;
    this.#master = masterKey;
  }

  async #load(orgId: string, kid: string): Promise<KeyRecord | undefined> {
    const name = nameOf(kid);
    const sealed = await getSecretRecord(this.#db, { orgId }, name);
    if (sealed === undefined) return undefined;
    const rec = JSON.parse(
      open(this.#master, sealed, secretAad(orgId, name), "oidc", orgId),
    ) as KeyRecord;
    // The kid in the record must be the thumbprint of the key inside it.
    if (rec.v !== 1 || rec.kid !== kid || publicJwkOf(rec.privateKeyPem).kid !== kid) {
      throw new Error("oidc key record does not match its name");
    }
    return rec;
  }

  async #save(orgId: string, rec: KeyRecord): Promise<void> {
    const name = nameOf(rec.kid);
    await putSecretRecord(
      this.#db,
      { orgId },
      name,
      seal(this.#master, JSON.stringify(rec), secretAad(orgId, name), "oidc", orgId),
    );
  }

  async #records(orgId: string): Promise<KeyRecord[]> {
    const names = (await listSecretNames(this.#db, { orgId })).filter((n) =>
      n.startsWith(KEY_PREFIX),
    );
    const out: KeyRecord[] = [];
    for (const n of names) {
      const rec = await this.#load(orgId, n.slice(KEY_PREFIX.length));
      if (rec) out.push(rec);
    }
    return out.toSorted((a, b) => a.createdAt - b.createdAt);
  }

  async #create(orgId: string, now: number, op: string): Promise<KeyRecord> {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const rec: KeyRecord = {
      v: 1,
      kid: publicJwkOf(privateKeyPem).kid,
      privateKeyPem,
      createdAt: now,
    };
    await this.#save(orgId, rec);
    // By kid only: a key never goes near the log.
    await appendAudit(
      this.#db,
      { orgId },
      {
        principalKind: "system",
        principalId: "oidc",
        op,
        effect: "write",
        outcome: "ok",
        input: { kid: rec.kid, alg: OIDC_ALG },
      },
    );
    return rec;
  }

  /** The key that signs now. Created on first use for an org. */
  async current(orgId: string, now = Date.now()): Promise<KeyRecord> {
    const live = (await this.#records(orgId)).filter((r) => r.rotatedOutAt === undefined);
    const newest = live.at(-1);
    return newest ?? (await this.#create(orgId, now, "oidc_key_create"));
  }

  /**
   * Makes a new key current. The old one is marked rotated out and stays in the JWKS for
   * MAX_TOKEN_SECONDS plus a grace, so tokens it signed stay verifiable until they expire.
   * Keys past that window are deleted.
   */
  async rotate(orgId: string, now = Date.now()): Promise<{ kid: string; retired: string[] }> {
    const recs = await this.#records(orgId);
    const retired: string[] = [];
    for (const r of recs) {
      if (r.rotatedOutAt === undefined) {
        await this.#save(orgId, { ...r, rotatedOutAt: now });
        retired.push(r.kid);
      }
    }
    const fresh = await this.#create(orgId, now, "oidc_key_rotate");
    await this.purge(orgId, now);
    return { kid: fresh.kid, retired };
  }

  /** Deletes keys whose last possible token has expired. Returns their kids. */
  async purge(orgId: string, now = Date.now()): Promise<string[]> {
    const gone: string[] = [];
    for (const r of await this.#records(orgId)) {
      if (r.rotatedOutAt !== undefined && now >= r.rotatedOutAt + publishedFor()) {
        await deleteSecretRecord(this.#db, { orgId }, nameOf(r.kid));
        gone.push(r.kid);
      }
    }
    return gone;
  }

  /** Keys to publish: the current one, and retired ones still inside their window. */
  async published(orgId: string, now = Date.now()): Promise<OidcKey[]> {
    await this.current(orgId, now);
    const out: OidcKey[] = [];
    for (const r of await this.#records(orgId)) {
      if (r.rotatedOutAt !== undefined && now >= r.rotatedOutAt + publishedFor()) continue;
      const jwk = publicJwkOf(r.privateKeyPem);
      assertPublicJwk(jwk as unknown as Record<string, unknown>);
      out.push({
        kid: r.kid,
        createdAt: r.createdAt,
        ...(r.rotatedOutAt === undefined ? {} : { rotatedOutAt: r.rotatedOutAt }),
        jwk,
      });
    }
    return out;
  }

  /** The JWKS document: public members only. */
  async jwks(orgId: string, now = Date.now()): Promise<{ keys: PublicJwk[] }> {
    return { keys: (await this.published(orgId, now)).map((k) => k.jwk) };
  }

  /** Signs a JWT with the current key, whose id goes in the header. Returns the token and kid. */
  async signJwt(
    orgId: string,
    claims: Record<string, unknown>,
    now = Date.now(),
  ): Promise<{ token: string; kid: string }> {
    const rec = await this.current(orgId, now);
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${enc({ alg: OIDC_ALG, typ: "JWT", kid: rec.kid })}.${enc(claims)}`;
    const sig = nodeSign("sha256", Buffer.from(input, "utf8"), {
      key: createPrivateKey(rec.privateKeyPem),
      dsaEncoding: "ieee-p1363", // the raw r||s form JOSE requires, not DER
    });
    return { token: `${input}.${sig.toString("base64url")}`, kid: rec.kid };
  }
}

const publishedFor = (): number => MAX_TOKEN_SECONDS * 1000 + RETIRED_GRACE_MS;
