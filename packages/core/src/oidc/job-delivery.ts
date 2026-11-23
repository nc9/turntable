// How a job gets an OIDC token. GitHub's contract is two variables, ACTIONS_ID_TOKEN_REQUEST_URL
// and ACTIONS_ID_TOKEN_REQUEST_TOKEN; tooling asks the URL for a token with the request token as
// the bearer. Here the request token in the sandbox is a placeholder: the secrets proxy attaches
// the real attempt credential to requests for the mint URL, so the sandbox never holds a usable
// credential and its egress stays deny-all-except-proxy.
//
// A job gets the variables only when all hold: the trust class may mint (the issuer's allow list,
// never `untrusted_pr` unless an operator widened it), the job asked with `id-token: write`, and
// the run's attempt is behind the proxy. Otherwise it gets neither variable, and the log says why.
import net from "node:net";
import { plannedIdToken } from "@turntable/act-runner";
import type { Db } from "../db";
import { getOrgById } from "../db/repos";
import { mintAttemptCredential } from "./attempt-credential";
import type { OidcIssuer } from "./issuer";

/**
 * What a minted credential lives for. It is minted per request, inside the proxy, and never
 * stored: a leak from worker memory or a redaction miss is good for this long, not for the job.
 */
export const OIDC_CREDENTIAL_MS = 2 * 60 * 1000;

/** What the request token holds inside the sandbox. The proxy adds the real one. */
export const OIDC_PLACEHOLDER_TOKEN = "turntable-oidc-credential-is-added-by-the-proxy";

export interface JobOidcRequest {
  orgId: string;
  attemptId: string;
  klass: string;
  /** The job's stored plan (`jobs.planned`). Whether it asked for a token is read from here only. */
  planned: string | null | undefined;
}

export interface IssuedJobOidc {
  /** ACTIONS_ID_TOKEN_REQUEST_URL: the org's mint endpoint. It already has a query, as GitHub's does. */
  requestUrl: string;
  /** ACTIONS_ID_TOKEN_REQUEST_TOKEN: always the placeholder. */
  requestToken: string;
  /**
   * A fresh credential for the proxy to attach to one request (valid `OIDC_CREDENTIAL_MS`).
   * Nothing holds on to what this returns. Never put in the sandbox.
   */
  credentialFor: () => string;
  /** Where the proxy's rule points. */
  mint: { host: string; port: number; pathPrefix: string };
}

export interface NoJobOidc {
  none: string;
}

export interface JobOidcOptions {
  db: Db;
  issuer: OidcIssuer;
  masterKey: Buffer;
  now?: () => number;
}

export class JobOidc {
  readonly #o: JobOidcOptions;

  constructor(o: JobOidcOptions) {
    this.#o = o;
  }

  /** Whether this class may mint at all, so the proxy rule is registered only for those. */
  allows(klass: string): boolean {
    return this.#o.issuer.allowsClass(klass);
  }

  /** For the proxy: the org's mint endpoint, only for a class that may mint. */
  proxyTarget(
    ctx: { scope: { orgId: string } },
    klass: string,
  ): Promise<IssuedJobOidc["mint"] | undefined> {
    return this.allows(klass) ? this.mintTarget(ctx.scope.orgId) : Promise.resolve(undefined);
  }

  /** The mint endpoint of an org, as the proxy's rule needs it. Undefined if the URL is unusable. */
  async mintTarget(orgId: string): Promise<IssuedJobOidc["mint"] | undefined> {
    const org = await getOrgById(this.#o.db, orgId);
    if (!org) return undefined;
    let u: URL;
    try {
      u = new URL(`${this.#o.issuer.issuerUrl(org.slug)}/token`);
    } catch {
      return undefined;
    }
    // The proxy reaches the control plane over https only (its outbound client refuses the rest),
    // and a proxy rule names a host, never an IP literal. Either way: no rule, no token, no throw.
    if (u.protocol !== "https:") return undefined;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) !== 0) return undefined;
    return { host: u.hostname, port: u.port === "" ? 443 : Number(u.port), pathPrefix: u.pathname };
  }

  async issue(r: JobOidcRequest): Promise<IssuedJobOidc | NoJobOidc> {
    if (!plannedIdToken(r.planned)) return { none: "the job did not ask for it" };
    if (!this.allows(r.klass)) return { none: `a ${r.klass} run may not mint an identity token` };
    const mint = await this.mintTarget(r.orgId);
    if (!mint) return { none: "the issuer URL is not an https host name" };
    const org = await getOrgById(this.#o.db, r.orgId);
    if (!org) return { none: "unknown org" };
    const clock = this.#o.now ?? Date.now;
    return {
      requestUrl: `${this.#o.issuer.issuerUrl(org.slug)}/token?api-version=2.0`,
      requestToken: OIDC_PLACEHOLDER_TOKEN,
      credentialFor: () =>
        mintAttemptCredential(
          this.#o.masterKey,
          { orgId: r.orgId, attemptId: r.attemptId },
          clock(),
          OIDC_CREDENTIAL_MS,
        ),
      mint,
    };
  }
}
