// Secrets, the GitHub App record, installations and webhook deliveries. Like index.ts, part of
// the only code allowed to name tenant tables. Secret values are stored only as sealed records
// and are never returned by any query written for an API response.
import { and, asc, eq, gt, inArray, isNull, like, lt, ne, notLike, or } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { DeliveryStatus, InstallationStatus } from "../schema";
import { type Scope, scoped } from "./scope";

export type GithubApp = typeof s.githubApps.$inferSelect;
export type GithubInstallation = typeof s.githubInstallations.$inferSelect;
export type WebhookDelivery = typeof s.webhookDeliveries.$inferSelect;

// ---- secrets (sealed records only) ----

const SECRET_COLS = { orgId: s.secrets.orgId };

export function putSecretRecord(
  db: Db,
  scope: Scope,
  name: string,
  ciphertext: string,
): Promise<void> {
  return db.run(async (h) => {
    const now = Date.now();
    await h.orm
      .insert(s.secrets)
      .values({ orgId: scope.orgId, name, ciphertext, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [s.secrets.orgId, s.secrets.name],
        set: { ciphertext, updatedAt: now },
      });
  });
}

export function getSecretRecord(db: Db, scope: Scope, name: string): Promise<string | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ ciphertext: s.secrets.ciphertext })
      .from(s.secrets)
      .where(scoped(scope, SECRET_COLS, eq(s.secrets.name, name)))
      .limit(1);
    return row?.ciphertext;
  });
}

export function deleteSecretRecord(db: Db, scope: Scope, name: string): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .delete(s.secrets)
      .where(scoped(scope, SECRET_COLS, eq(s.secrets.name, name)))
      .returning({ name: s.secrets.name });
    return rows.length > 0;
  });
}

/** Orgs that hold a system secret of this name. System-level: the checkpointer finds orgs with a signing key. */
export function orgsWithSecretName(db: Db, name: string): Promise<string[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ orgId: s.secrets.orgId })
      .from(s.secrets)
      .where(eq(s.secrets.name, name));
    return rows.map((r) => r.orgId);
  });
}

/** Names only. */
export function listSecretNames(db: Db, scope: Scope): Promise<string[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ name: s.secrets.name })
      .from(s.secrets)
      .where(scoped(scope, SECRET_COLS))
      .orderBy(asc(s.secrets.name));
    return rows.map((r) => r.name);
  });
}

// ---- the App ----

export type GithubAppInput = {
  appId: string;
  slug: string;
  name: string;
  ownerLogin: string;
  htmlUrl: string;
  clientId: string;
};

export function setGithubApp(db: Db, scope: Scope, input: GithubAppInput): Promise<GithubApp> {
  return db.run(async (h) => {
    await h.orm
      .insert(s.githubApps)
      .values({ ...input, orgId: scope.orgId })
      .onConflictDoUpdate({
        target: s.githubApps.appId,
        set: { ...input, orgId: scope.orgId },
      });
    const [row] = await h.orm
      .select()
      .from(s.githubApps)
      .where(eq(s.githubApps.appId, input.appId))
      .limit(1);
    return row!;
  });
}

/**
 * The instance's App, if configured. Unscoped on purpose: a webhook arrives before any tenant
 * is known, and the App row is what says which org it belongs to.
 */
export function getGithubApp(db: Db): Promise<GithubApp | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.githubApps)
      .orderBy(asc(s.githubApps.createdAt))
      .limit(1);
    return row;
  });
}

export function setPreviousSecretExpiry(db: Db, appId: string, at: number | null): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.githubApps)
      .set({ previousSecretExpiresAt: at })
      .where(eq(s.githubApps.appId, appId));
  });
}

// ---- installations ----

export type InstallationInput = {
  installationId: string;
  appId: string;
  accountLogin: string;
  accountId: string;
  accountType: string;
  repositorySelection: string;
  status: InstallationStatus;
};

export function upsertInstallation(
  db: Db,
  scope: Scope,
  input: InstallationInput,
): Promise<GithubInstallation> {
  return db.run(async (h) => {
    const now = Date.now();
    await h.orm
      .insert(s.githubInstallations)
      .values({ ...input, orgId: scope.orgId, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: s.githubInstallations.installationId,
        // The org of an existing installation never changes here.
        set: {
          accountLogin: input.accountLogin,
          accountId: input.accountId,
          accountType: input.accountType,
          repositorySelection: input.repositorySelection,
          status: input.status,
          updatedAt: now,
        },
      });
    const [row] = await h.orm
      .select()
      .from(s.githubInstallations)
      .where(eq(s.githubInstallations.installationId, input.installationId))
      .limit(1);
    return row!;
  });
}

/** Routing lookup by installation id (unscoped: the id is what finds the tenant). */
export function getInstallation(
  db: Db,
  installationId: string,
): Promise<GithubInstallation | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.githubInstallations)
      .where(eq(s.githubInstallations.installationId, installationId))
      .limit(1);
    return row;
  });
}

export function listInstallations(db: Db, scope: Scope): Promise<GithubInstallation[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.githubInstallations)
      .where(scoped(scope, { orgId: s.githubInstallations.orgId }))
      .orderBy(asc(s.githubInstallations.createdAt)),
  );
}

export function setInstallationStatus(
  db: Db,
  scope: Scope,
  installationId: string,
  status: InstallationStatus,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.githubInstallations)
      .set({ status, updatedAt: Date.now() })
      .where(
        scoped(
          scope,
          { orgId: s.githubInstallations.orgId },
          eq(s.githubInstallations.installationId, installationId),
        ),
      )
      .returning({ id: s.githubInstallations.installationId });
    return rows.length > 0;
  });
}

// ---- repo bindings by forge facts ----

export type RepoBinding = typeof s.projectRepos.$inferSelect;

/** A bound repo by GitHub's stable numeric id (unscoped: used to detect ownership conflicts). */
export function findGithubRepoBinding(
  db: Db,
  input: { forgeRepoId: string; owner: string; repo: string },
): Promise<RepoBinding | undefined> {
  return db.run(async (h) => {
    const [byId] = await h.orm
      .select()
      .from(s.projectRepos)
      .where(
        and(eq(s.projectRepos.forge, "github"), eq(s.projectRepos.forgeRepoId, input.forgeRepoId)),
      )
      .limit(1);
    if (byId) return byId;
    const [byName] = await h.orm
      .select()
      .from(s.projectRepos)
      .where(
        and(
          eq(s.projectRepos.forge, "github"),
          eq(s.projectRepos.owner, input.owner.toLowerCase()),
          eq(s.projectRepos.repo, input.repo.toLowerCase()),
        ),
      )
      .limit(1);
    return byName;
  });
}

/** A binding by forge and name, whichever project or org holds it (unscoped, for the instance admin and the poller). */
export function findRepoBindingByName(
  db: Db,
  input: { forge: s.Forge; owner: string; repo: string },
): Promise<RepoBinding | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.projectRepos)
      .where(
        and(
          eq(s.projectRepos.forge, input.forge),
          eq(s.projectRepos.owner, input.owner.toLowerCase()),
          eq(s.projectRepos.repo, input.repo.toLowerCase()),
        ),
      )
      .limit(1);
    return row;
  });
}

const SEEN_COPY_CHUNK = 100;

/**
 * Moves a binding to another project (and org) in one update, keeping its installation. The
 * poller's seen markers of the repo are copied to the new project, so a poll at the same head does
 * not run it again there; the old project keeps its own markers with its runs. Call it inside a
 * transaction. False when the binding is gone.
 */
export function moveRepoBinding(
  db: Db,
  bindingId: string,
  to: { orgId: string; projectId: string },
): Promise<boolean> {
  return db.run(async (h) => {
    const [b] = await h.orm
      .select()
      .from(s.projectRepos)
      .where(eq(s.projectRepos.id, bindingId))
      .limit(1);
    if (!b) return false;
    const rows = await h.orm
      .update(s.projectRepos)
      .set({ orgId: to.orgId, projectId: to.projectId })
      .where(eq(s.projectRepos.id, bindingId))
      .returning({ id: s.projectRepos.id });
    if (rows.length === 0) return false;
    const seen = await h.orm
      .select()
      .from(s.pollSeen)
      .where(
        and(eq(s.pollSeen.projectId, b.projectId), eq(s.pollSeen.repo, `${b.owner}/${b.repo}`)),
      );
    for (let i = 0; i < seen.length; i += SEEN_COPY_CHUNK) {
      await h.orm
        .insert(s.pollSeen)
        .values(seen.slice(i, i + SEEN_COPY_CHUNK).map((r) => ({ ...r, ...to })))
        .onConflictDoNothing();
    }
    return true;
  });
}

/**
 * Adopts a binding made without an installation (a polled repo) into an installation: sets its
 * installation id, and its forge repo id when it had none. The project stays. Only a binding of
 * this org with a null installation, and a null or equal forge repo id, is touched.
 */
export function adoptRepoBinding(
  db: Db,
  scope: Scope,
  bindingId: string,
  to: { installationId: string; forgeRepoId: string },
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.projectRepos)
      .set({ installationId: to.installationId, forgeRepoId: to.forgeRepoId })
      .where(
        scoped(
          scope,
          { orgId: s.projectRepos.orgId },
          eq(s.projectRepos.id, bindingId),
          isNull(s.projectRepos.installationId),
          or(isNull(s.projectRepos.forgeRepoId), eq(s.projectRepos.forgeRepoId, to.forgeRepoId)),
        ),
      )
      .returning({ id: s.projectRepos.id });
    return rows.length > 0;
  });
}

/**
 * Active installations whose org holds a GitHub binding with no installation (a polled repo):
 * the only ones the boot sweep has anything to adopt for. Two cheap queries, no GitHub call.
 */
export function listInstallationsWithPolledBindings(db: Db): Promise<GithubInstallation[]> {
  return db.run(async (h) => {
    const polled = await h.orm
      .selectDistinct({ orgId: s.projectRepos.orgId })
      .from(s.projectRepos)
      .where(and(eq(s.projectRepos.forge, "github"), isNull(s.projectRepos.installationId)));
    if (polled.length === 0) return [];
    return h.orm
      .select()
      .from(s.githubInstallations)
      .where(
        and(
          eq(s.githubInstallations.status, "active"),
          inArray(
            s.githubInstallations.orgId,
            polled.map((r) => r.orgId),
          ),
        ),
      )
      .orderBy(asc(s.githubInstallations.createdAt));
  });
}

/** Bindings that came from one installation. */
export function listInstallationBindings(
  db: Db,
  scope: Scope,
  installationId: string,
): Promise<RepoBinding[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.projectRepos)
      .where(
        scoped(
          scope,
          { orgId: s.projectRepos.orgId },
          eq(s.projectRepos.installationId, installationId),
        ),
      ),
  );
}

export function unbindRepo(db: Db, scope: Scope, bindingId: string): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .delete(s.projectRepos)
      .where(scoped(scope, { orgId: s.projectRepos.orgId }, eq(s.projectRepos.id, bindingId)))
      .returning({ id: s.projectRepos.id });
    return rows.length > 0;
  });
}

// ---- webhook deliveries ----

/** Stores a delivery. `duplicate` when the GUID was seen before (replay or GitHub redelivery). */
export function recordDelivery(
  db: Db,
  d: {
    id: string;
    orgId: string;
    event: string;
    action?: string | undefined;
    installationId?: string | undefined;
    payload?: string | undefined;
    status?: DeliveryStatus;
  },
): Promise<"new" | "duplicate"> {
  return db.run(async (h) => {
    const rows = await h.orm
      .insert(s.webhookDeliveries)
      .values({
        id: d.id,
        orgId: d.orgId,
        event: d.event,
        action: d.action ?? null,
        installationId: d.installationId ?? null,
        payload: d.payload ?? null,
        status: d.status ?? "received",
      })
      .onConflictDoNothing()
      .returning({ id: s.webhookDeliveries.id });
    return rows.length > 0 ? "new" : "duplicate";
  });
}

export function finishDelivery(
  db: Db,
  id: string,
  status: DeliveryStatus,
  error?: string,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.webhookDeliveries)
      .set({
        status,
        error: error ? error.slice(0, 500) : null,
        processedAt: Date.now(),
        payload: null,
      })
      .where(eq(s.webhookDeliveries.id, id));
  });
}

export function getDelivery(db: Db, id: string): Promise<WebhookDelivery | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.webhookDeliveries)
      .where(eq(s.webhookDeliveries.id, id))
      .limit(1);
    return row;
  });
}

/** Deliveries stored but not finished (a crash between the 202 and the handler). */
export function listUnfinishedDeliveries(db: Db, limit = 50): Promise<WebhookDelivery[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.webhookDeliveries)
      .where(eq(s.webhookDeliveries.status, "received"))
      .orderBy(asc(s.webhookDeliveries.receivedAt))
      .limit(limit),
  );
}

/** Retention: drops deliveries received before `before` (epoch ms). Returns how many. */
export function purgeDeliveries(db: Db, before: number): Promise<number> {
  return db.run(async (h) => {
    const rows = await h.orm
      .delete(s.webhookDeliveries)
      .where(lt(s.webhookDeliveries.receivedAt, before))
      .returning({ id: s.webhookDeliveries.id });
    return rows.length;
  });
}

// ---- installation claims (hosted multi-tenant installs) ----

export type InstallationClaim = typeof s.installationClaims.$inferSelect;

export function createInstallationClaim(
  db: Db,
  scope: Scope,
  input: { nonce: string; startedBy: string; expiresAt: number; expectedLogin?: string },
): Promise<void> {
  return db.run(async (h) => {
    await h.orm.insert(s.installationClaims).values({
      nonce: input.nonce,
      orgId: scope.orgId,
      startedBy: input.startedBy,
      expiresAt: input.expiresAt,
      expectedLogin: input.expectedLogin ?? null,
    });
  });
}

/** A claim by nonce, used or not (the callback checks the rest). App manifest nonces are never claims. */
export function getInstallationClaim(
  db: Db,
  nonce: string,
): Promise<InstallationClaim | undefined> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select()
      .from(s.installationClaims)
      .where(
        and(
          eq(s.installationClaims.nonce, nonce),
          notLike(s.installationClaims.startedBy, `${MANIFEST_NONCE_PREFIX}%`),
        ),
      );
    return rows[0];
  });
}

/**
 * Consumes a claim: atomic, so a state is accepted once. Returns the claim, or undefined when the
 * nonce is unknown, expired, already used or an App manifest nonce.
 */
export function consumeInstallationClaim(
  db: Db,
  nonce: string,
  installationId: string,
  now: number,
  github: { userId: string; login: string },
): Promise<InstallationClaim | undefined> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.installationClaims)
      .set({
        usedAt: now,
        installationId,
        githubUserId: github.userId,
        githubLogin: github.login,
      })
      .where(
        and(
          eq(s.installationClaims.nonce, nonce),
          notLike(s.installationClaims.startedBy, `${MANIFEST_NONCE_PREFIX}%`),
          isNull(s.installationClaims.usedAt),
          gt(s.installationClaims.expiresAt, now),
        ),
      )
      .returning();
    return rows[0];
  });
}

// ---- the hosted App manifest flow (github/hosted-manifest.ts) ----

/** `startedBy` prefix of an installation_claims row that is really an App manifest nonce. */
export const MANIFEST_NONCE_PREFIX = "app-manifest:";

/**
 * Records the single-use nonce of an App manifest flow. It reuses `installation_claims` (a nonce,
 * its owner org and an expiry is all either flow needs); the prefix on `startedBy` keeps the two
 * kinds apart, and each flow's state is signed under its own key.
 */
export function createManifestNonce(
  db: Db,
  scope: Scope,
  input: { nonce: string; startedBy: string; expiresAt: number },
): Promise<void> {
  return db.run(async (h) => {
    await h.orm.insert(s.installationClaims).values({
      nonce: input.nonce,
      orgId: scope.orgId,
      startedBy: `${MANIFEST_NONCE_PREFIX}${input.startedBy}`,
      expiresAt: input.expiresAt,
    });
  });
}

/** Consumes a manifest nonce, atomically. False when unknown, expired, used, or not a manifest nonce. */
export function consumeManifestNonce(db: Db, nonce: string, now: number): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.installationClaims)
      .set({ usedAt: now })
      .where(
        and(
          eq(s.installationClaims.nonce, nonce),
          like(s.installationClaims.startedBy, `${MANIFEST_NONCE_PREFIX}%`),
          isNull(s.installationClaims.usedAt),
          gt(s.installationClaims.expiresAt, now),
        ),
      )
      .returning({ n: s.installationClaims.nonce });
    return rows.length > 0;
  });
}

/** Drops this org's App rows other than `keepAppId` (a replaced App). Returns the removed ids. */
export function removeOtherGithubApps(db: Db, scope: Scope, keepAppId: string): Promise<string[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .delete(s.githubApps)
      .where(and(eq(s.githubApps.orgId, scope.orgId), ne(s.githubApps.appId, keepAppId)))
      .returning({ id: s.githubApps.appId });
    return rows.map((r) => r.id);
  });
}

/** True while a manifest flow has been started, is unexpired, and has not been finished. */
export function hasOpenManifestNonce(db: Db, now: number): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ n: s.installationClaims.nonce })
      .from(s.installationClaims)
      .where(
        and(
          like(s.installationClaims.startedBy, `${MANIFEST_NONCE_PREFIX}%`),
          isNull(s.installationClaims.usedAt),
          gt(s.installationClaims.expiresAt, now),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * The installations of replaced Apps are dead (their App no longer exists here): mark them
 * deleted and drop the repository bindings they granted. Unscoped on purpose: an App's
 * installations belong to every org that claimed one. Returns what was retired, for the audit.
 */
export function retireAppInstallations(
  db: Db,
  appIds: readonly string[],
): Promise<{ installations: number; repos: number }> {
  return db.run(async (h) => {
    if (appIds.length === 0) return { installations: 0, repos: 0 };
    const live = await h.orm
      .select()
      .from(s.githubInstallations)
      .where(
        and(
          inArray(s.githubInstallations.appId, [...appIds]),
          ne(s.githubInstallations.status, "deleted"),
        ),
      );
    let repos = 0;
    for (const i of live) {
      const gone = await h.orm
        .delete(s.projectRepos)
        .where(
          and(
            eq(s.projectRepos.orgId, i.orgId),
            eq(s.projectRepos.installationId, i.installationId),
          ),
        )
        .returning({ id: s.projectRepos.id });
      repos += gone.length;
      await h.orm
        .update(s.githubInstallations)
        .set({ status: "deleted", updatedAt: Date.now() })
        .where(eq(s.githubInstallations.installationId, i.installationId));
    }
    return { installations: live.length, repos };
  });
}
