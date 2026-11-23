import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { createOrg, openDatabase, setGithubApp, type Db } from "../src/db";
import type { GithubFacts, GithubInstallationFacts, GithubRepoFacts } from "../src/github/api";
import { SECRET_APP_ID, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "../src/github/app-auth";
import { SecretStore } from "../src/secrets/store";

export const WEBHOOK_SECRET = "whsec-test-secret-0123456789";

export const rsa = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

export async function setup(appId = "42", open: () => Db = () => openDatabase(":memory:")) {
  const db: Db = open();
  const org = await createOrg(db, { slug: "acme", name: "Acme" });
  const store = new SecretStore(db, randomBytes(32));
  await setGithubApp(
    db,
    { orgId: org.id },
    {
      appId,
      slug: "turntable-test",
      name: "Turntable",
      ownerLogin: "acme",
      htmlUrl: "https://github.com/apps/turntable-test",
      clientId: "Iv1.abc",
    },
  );
  await store.set(org.id, SECRET_APP_ID, appId);
  await store.set(org.id, SECRET_PRIVATE_KEY, rsa.privateKey);
  await store.set(org.id, SECRET_WEBHOOK, WEBHOOK_SECRET);
  return { db, org, store };
}

export const sign = (secret: string, body: string | Uint8Array): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** A fake of what the GitHub API says. Tests mutate `installations` and `repos`. */
export function fakeFacts() {
  const installations = new Map<string, GithubInstallationFacts>();
  const repos = new Map<string, GithubRepoFacts[]>();
  const calls = { getInstallation: 0, listRepos: 0 };
  const facts: GithubFacts = {
    async getInstallation(id) {
      calls.getInstallation += 1;
      return installations.get(id);
    },
    async listInstallationRepos(id) {
      calls.listRepos += 1;
      return repos.get(id) ?? [];
    },
  };
  return { facts, installations, repos, calls };
}

export const inst = (
  id: string,
  appId = "42",
  extra: Partial<GithubInstallationFacts> = {},
): GithubInstallationFacts => ({
  id,
  appId,
  account: { login: "acme", id: "7", type: "Organization" },
  repositorySelection: "selected",
  suspended: false,
  ...extra,
});

export const repo = (id: string, name: string, owner = "acme"): GithubRepoFacts => ({
  id,
  name,
  owner,
  fullName: `${owner}/${name}`,
});

/** A fake GitHub user behind an OAuth code, for the installation claim flow. */
export interface FakeClaimUser {
  id: string;
  login: string;
  installations: { id: string; accountId: string; accountLogin: string; accountType: string }[];
  /** Organizations where this user is an active admin. */
  adminOf: string[];
}

/** Codes map to users; an unknown code is refused like GitHub refuses a bad code. */
export function fakeUserVerifier(users: Map<string, FakeClaimUser>): {
  verify(code: string): Promise<{
    id: string;
    login: string;
    installations: FakeClaimUser["installations"];
    isOrgAdmin(org: string): Promise<boolean>;
  }>;
} {
  return {
    async verify(code) {
      const u = users.get(code);
      if (!u) throw new Error("bad code");
      return {
        id: u.id,
        login: u.login,
        installations: u.installations,
        isOrgAdmin: async (org) => u.adminOf.includes(org),
      };
    },
  };
}

/** The owner of installation 100 on org `acme` (the default `inst` account). */
export const ownerOf100: FakeClaimUser = {
  id: "9",
  login: "owner-b",
  installations: [{ id: "100", accountId: "7", accountLogin: "acme", accountType: "Organization" }],
  adminOf: ["acme"],
};
