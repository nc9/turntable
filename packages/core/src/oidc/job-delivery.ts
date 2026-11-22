// How a job gets an OIDC token. GitHub's contract is two variables, ACTIONS_ID_TOKEN_REQUEST_URL
// and ACTIONS_ID_TOKEN_REQUEST_TOKEN; tooling asks the URL for a token with the request token as
// the bearer. Here the request token in the sandbox is a placeholder: the secrets proxy attaches
// the real attempt credential to requests for the mint URL, so the sandbox never holds a usable
// credential and its egress stays deny-all-except-proxy.
//
// A job gets the variables only when all hold: the trust class may mint (the issuer's allow list,
// never `untrusted_pr` unless an operator widened it), the job asked with `id-token: write`, and
// the run's attempt is behind the proxy. Otherwise it gets neither variable, and the log says why.
import { wantsIdToken } from "@longshore/act-runner";
import type { Db } from "../db";
import { getOrgById } from "../db/repos";
import { mintAttemptCredential } from "./attempt-credential";
import type { OidcIssuer } from "./issuer";

/** What the credential lives for: the longest a job runs (the proxy's own default), with room. */
export const OIDC_CREDENTIAL_MS = 6 * 3600 * 1000;

/** What the request token holds inside the sandbox. The proxy adds the real one. */
export const OIDC_PLACEHOLDER_TOKEN = "longshore-oidc-credential-is-added-by-the-proxy";

export interface JobOidcRequest {
  orgId: string;
  attemptId: string;
  klass: string;
  workflowYaml: string;
  jobId: string;
}

export interface IssuedJobOidc {
  /** ACTIONS_ID_TOKEN_REQUEST_URL: the org's mint endpoint. It already has a query, as GitHub's does. */
  requestUrl: string;
  /** ACTIONS_ID_TOKEN_REQUEST_TOKEN: always the placeholder. */
  requestToken: string;
  /** The real credential, for the proxy to attach. Never put in the sandbox. */
  credential: string;
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
    const u = new URL(`${this.#o.issuer.issuerUrl(org.slug)}/token`);
    // The proxy reaches the control plane over https only (its outbound client refuses the rest).
    if (u.protocol !== "https:") return undefined;
    return { host: u.hostname, port: u.port === "" ? 443 : Number(u.port), pathPrefix: u.pathname };
  }

  async issue(r: JobOidcRequest): Promise<IssuedJobOidc | NoJobOidc> {
    if (!wantsIdToken(r.workflowYaml, r.jobId)) return { none: "the job did not ask for it" };
    if (!this.allows(r.klass)) return { none: `a ${r.klass} run may not mint an identity token` };
    const mint = await this.mintTarget(r.orgId);
    if (!mint) return { none: "the issuer URL is not https" };
    const org = await getOrgById(this.#o.db, r.orgId);
    if (!org) return { none: "unknown org" };
    const now = (this.#o.now ?? Date.now)();
    return {
      requestUrl: `${this.#o.issuer.issuerUrl(org.slug)}/token?api-version=2.0`,
      requestToken: OIDC_PLACEHOLDER_TOKEN,
      credential: mintAttemptCredential(
        this.#o.masterKey,
        { orgId: r.orgId, attemptId: r.attemptId },
        now,
        OIDC_CREDENTIAL_MS,
      ),
      mint,
    };
  }
}
