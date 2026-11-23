import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type Db } from "../src/db";
import * as s from "../src/db/schema";
import { createOidcHandler, type OidcHandler } from "../src/oidc/http";
import { OidcIssuer } from "../src/oidc/issuer";
import { JobOidc } from "../src/oidc/job-delivery";
import { seedWorld, type Tenant } from "./ops-helpers";

// CI only (TT_VAULT_E2E=1): Linux with Docker and openssl. A Vault dev server (the image is pinned
// by digest in TT_VAULT_IMAGE) is configured with a jwt auth role that trusts this issuer's
// JWKS, and real tokens, minted through the real mint path, are used to log in. Vault runs on the
// host network so it reaches the issuer on loopback; the issuer is served over TLS because Vault
// wants an https JWKS URL, and Vault is given the certificate as `jwks_ca_pem`.
const enabled = process.env.TT_VAULT_E2E === "1";
const IMAGE = process.env.TT_VAULT_IMAGE ?? "";
const AUDIENCE = "vault.example.test";
const tmp = mkdtempSync(join(tmpdir(), "tt-vault-e2e-"));
const container = `tt-vault-e2e-${randomBytes(4).toString("hex")}`;
// Built at run time: nothing here is a real credential, and a literal would trip scanners.
const ROOT = randomBytes(16).toString("hex");

let db: Db;
let a: Tenant;
let master: Buffer;
let handler: OidcHandler;
let server: ReturnType<typeof Bun.serve> | undefined;
let issuerUrl = "";
let vault = "";
let jobOidc: JobOidc;

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function sh(...argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} failed: ${err}`);
  return out;
}

async function vaultApi(path: string, body?: unknown, token = ROOT) {
  const res = await fetch(`${vault}/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-vault-token": token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

/** Mint a job token through the real path: the credential the proxy would attach, then the endpoint. */
async function mint(
  audience: string,
  o: { clock?: () => number; handlerFor?: OidcHandler; jobOidcFor?: JobOidc } = {},
): Promise<string> {
  const issued = await (o.jobOidcFor ?? jobOidc).issue({
    orgId: a.orgId,
    attemptId: a.attemptId,
    klass: "protected",
    workflowYaml:
      "name: t\non: push\njobs:\n  a:\n    runs-on: x\n    permissions:\n      id-token: write\n    steps: []\n",
    jobId: "a",
  });
  if ("none" in issued) throw new Error(issued.none);
  const res = await (o.handlerFor ?? handler).handle(
    new Request(`${issuerUrl}/token?audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `Bearer ${issued.credentialFor()}` },
    }),
  );
  if (res?.status !== 200) throw new Error(`mint failed: ${res?.status} ${await res?.text()}`);
  return ((await res.json()) as { value: string }).value;
}

const login = (jwt: string) => vaultApi("auth/jwt/login", { role: "ci", jwt });

async function setRun(patch: Partial<typeof s.runs.$inferInsert>): Promise<void> {
  await db.orm.update(s.runs).set(patch).where(eq(s.runs.id, a.runId));
}

beforeAll(async () => {
  if (!enabled) return;
  if (!IMAGE.includes("@sha256:")) throw new Error("TT_VAULT_IMAGE must be pinned by digest");
  ({ db, a } = await seedWorld());
  master = randomBytes(32);
  await db.orm
    .update(s.jobAttempts)
    .set({ state: "running", trustClass: "protected" })
    .where(eq(s.jobAttempts.id, a.attemptId));
  await setRun({
    trust: JSON.stringify({ class: "protected", workflowHash: "h" }),
    repo: "acme/web",
    actor: "octo",
    ref: "refs/heads/main",
    event: "push",
  });

  // The issuer, served over TLS on loopback with a throwaway certificate.
  const port = await freePort();
  // A host name, not 127.0.0.1: a proxy rule names a host, and JobOidc issues nothing for an IP.
  issuerUrl = `https://localhost:${port}/oidc/${a.slug}`;
  const issuer = new OidcIssuer({
    db,
    masterKey: master,
    baseUrl: `https://localhost:${port}/oidc`,
  });
  handler = createOidcHandler({ db, issuer, masterKey: master });
  jobOidc = new JobOidc({ db, issuer, masterKey: master });
  const crt = join(tmp, "issuer.crt");
  const key = join(tmp, "issuer.key");
  await sh(
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    crt,
  );
  server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    tls: { cert: readFileSync(crt, "utf8"), key: readFileSync(key, "utf8") },
    fetch: async (req) => (await handler.handle(req)) ?? new Response("not found", { status: 404 }),
  });
  // Create the org's key before Vault looks at the JWKS.
  await mint(AUDIENCE);

  // Vault, dev mode, on the host network.
  const vp = await freePort();
  vault = `http://127.0.0.1:${vp}`;
  await sh(
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "--network",
    "host",
    "--cap-add",
    "IPC_LOCK",
    "-e",
    `VAULT_DEV_ROOT_TOKEN_ID=${ROOT}`,
    "-e",
    `VAULT_DEV_LISTEN_ADDRESS=127.0.0.1:${vp}`,
    IMAGE,
  );
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${vault}/v1/sys/health`)).status === 200) break;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
    if (i === 59) throw new Error("vault did not start");
  }
  expect((await vaultApi("sys/auth/jwt", { type: "jwt" })).status).toBeLessThan(300);
  const cfg = await vaultApi("auth/jwt/config", {
    jwks_url: `${issuerUrl}/jwks.json`,
    jwks_ca_pem: readFileSync(crt, "utf8"),
    bound_issuer: issuerUrl,
  });
  if (cfg.status >= 300) throw new Error(`vault jwt config refused: ${cfg.text}`);
  const role = await vaultApi("auth/jwt/role/ci", {
    role_type: "jwt",
    user_claim: "sub",
    bound_audiences: [AUDIENCE],
    bound_claims_type: "string",
    bound_claims: { repository: "acme/web", ref: "refs/heads/main", trust_class: "protected" },
    token_policies: ["default"],
    token_ttl: "5m",
  });
  if (role.status >= 300) throw new Error(`vault role refused: ${role.text}`);
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (enabled)
    await Bun.spawn(["docker", "rm", "-f", container], { stdout: "ignore", stderr: "ignore" })
      .exited;
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!enabled)("Vault JWT auth against the per-org issuer (docker, Linux)", () => {
  test("a job token with the bound audience and claims logs in, and the identity is the sub", async () => {
    const jwt = await mint(AUDIENCE);
    const r = await login(jwt);
    expect(r.status).toBe(200);
    expect(r.json.auth.client_token).toBeTruthy();
    expect(r.json.auth.metadata.role).toBe("ci");
    expect(r.json.auth.token_policies).toContain("default");
  });

  test("the wrong audience is refused, for the audience", async () => {
    const r = await login(await mint("somewhere-else.example.test"));
    expect(r.status).toBe(400);
    expect(r.text.toLowerCase()).toContain("aud");
  });

  test("an expired token is refused", async () => {
    // Minted by an issuer whose clock is an hour behind: valid in every way except exp.
    const past = () => Date.now() - 3600_000;
    const issuer = new OidcIssuer({
      db,
      masterKey: master,
      baseUrl: issuerUrl.replace(/\/[^/]+$/, ""),
      now: past,
    });
    const jwt = await mint(AUDIENCE, {
      handlerFor: createOidcHandler({ db, issuer, masterKey: master, now: past }),
      jobOidcFor: new JobOidc({ db, issuer, masterKey: master, now: past }),
    });
    const r = await login(jwt);
    expect(r.status).toBe(400);
    expect(r.text.toLowerCase()).toMatch(/expired|exp/);
  });

  test("a token for another repository is refused by the bound claims", async () => {
    await setRun({ repo: "acme/other" });
    try {
      const r = await login(await mint(AUDIENCE));
      expect(r.status).toBe(400);
      expect(r.text).toContain("repository");
    } finally {
      await setRun({ repo: "acme/web" });
    }
    // Control: the same attempt, back on the bound repository, logs in again.
    expect((await login(await mint(AUDIENCE))).status).toBe(200);
  });

  test("another ref and another trust class are refused too", async () => {
    await setRun({ ref: "refs/heads/dev" });
    try {
      const r = await login(await mint(AUDIENCE));
      expect(r.status).toBe(400);
      expect(r.text).toContain("ref");
    } finally {
      await setRun({ ref: "refs/heads/main" });
    }
  });
});
