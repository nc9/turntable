// `turntable serve --roles release`: the release lane as its own process.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LocalSigner } from "@turntable/signer";
import { createApprovalVerifier } from "../approvals/verifier";
import { type Db, ensureInstance, openDatabase } from "../db";
import { getRunArtifactsByName } from "../db/repos";
import { SecretVault } from "../secrets/vault";
import { SigningService } from "../signing";
import { type ReleaseConfig, releaseConfigFromEnv, releaseMasterKey } from "../roles";
import { systemOrgId } from "../audit/failures";
import { rewrapReleaseKey } from "./rewrap";
import { AttestationStore } from "./attest";
import { LaneConfig } from "./config";
import { dirArtifacts } from "./artifacts";
import { type ForgeFacts, githubForge } from "./forge";
import type { PublishWiring } from "./publish/types";
import { fileKeyVault } from "./key-vault";
import { startChannel } from "./channel";
import { ReleaseProxy } from "./proxy";
import { ReleaseLane, type ArtifactRecords, type ReleaseSigner } from "./lane";

/** What the lane needs from the signing service and the artifact records. */
export interface ReleaseWiring {
  signer: ReleaseSigner;
  records: ArtifactRecords;
}

export type WiringFactory = (deps: {
  db: Db;
  masterKey: Buffer;
  dataDir: string;
  builderId: string;
}) => ReleaseWiring | Promise<ReleaseWiring>;

/** Where the lane's built-in signing keys are sealed, inside its own data directory. */
export const keysDir = (dataDir: string): string => join(resolve(dataDir), "keys");

/**
 * The real wiring: the signing service with the built-in backend (keys sealed under the release
 * master key, in the lane's own directory), approvals verified from the main database, and the
 * recorded artifact digests read from it only to compare with the bytes.
 */
export const signingWiring: WiringFactory = ({ db, masterKey, dataDir, builderId }) => {
  const service = new SigningService({
    db,
    signers: { builtin: new LocalSigner(fileKeyVault(keysDir(dataDir), masterKey)) },
    approvals: createApprovalVerifier(db),
    builderId,
  });
  return {
    signer: {
      signRelease: (scope, req) => service.signRelease(scope, req),
      checkKey: (scope) => service.checkKey(scope),
    },
    records: {
      async recorded(scope, runId, names) {
        const rows = await getRunArtifactsByName(db, scope, runId, names);
        return rows.map((a) => ({ name: a.name, sha256: a.sha256, size: a.size }));
      },
    },
  };
};

/** The worker's request key: the value a supervising parent gave, else the key file. */
function channelKey(c: NonNullable<ReleaseConfig["channel"]>): string {
  if (c.key) return c.key;
  if (!c.keyFile) throw new Error("the release channel has no key");
  return readFileSync(c.keyFile, "utf8").trim();
}

export async function serveRelease(
  values: { "data-dir": string },
  wiring: WiringFactory = signingWiring,
  env: Record<string, string | undefined> = process.env,
  /** Test seam: a stand-in forge, so a test of the process wiring needs no network. */
  deps: { forge?: ForgeFacts } = {},
): Promise<{ stop(): void }> {
  const cfg = releaseConfigFromEnv(env);
  // The lane's own master key, in its own file: the main process neither has nor can read it.
  const masterKey = releaseMasterKey(cfg);
  const log = (m: string) => console.log(`[turntable release] ${m}`);
  // Requests come from the main database; everything the lane itself holds is in its own files.
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  await ensureInstance(db);
  // A rotation: all or nothing, before anything reads what the lane's key seals.
  if (cfg.previousMasterKey) {
    await rewrapReleaseKey({
      db,
      next: masterKey,
      previous: cfg.previousMasterKey,
      keysDir: keysDir(resolve(cfg.dataDir)),
      auditOrgId: await systemOrgId(db),
      log,
    });
    log(
      "the previous release key is set: once a clean boot is confirmed and a new backup is taken, remove it",
    );
  }
  const attest = new AttestationStore(join(resolve(cfg.dataDir), "attested.db"));
  const { signer, records } = await wiring({
    db,
    masterKey,
    dataDir: resolve(cfg.dataDir),
    builderId: cfg.builderId,
  });
  // Publishing: the lane's own vault view (it alone can open release-class secrets) and its own
  // GitHub write credential. With no targets declared this does nothing.
  const vault = new SecretVault({ db, masterKey, lane: "release" });
  const publish: PublishWiring = {
    credentials: {
      async secret(scope, name, destination, tag, requestId) {
        const r = await vault.usePublishCredential({ ...scope, name, destination, tag, requestId });
        return r.ok ? r.value : undefined;
      },
      async githubToken() {
        return cfg.githubPublishToken;
      },
    },
  };
  const forge = deps.forge ?? githubForge({ token: cfg.githubToken });
  const lane = new ReleaseLane({
    db,
    forge,
    bytes: dirArtifacts(cfg.artifactDir),
    records,
    attest,
    signer,
    publish,
    owner: `release-lane:${process.pid}`,
    log,
  });
  // Compat publishing: the release proxy, only when asked for. It is the lane's own listener, so
  // the credential it injects stays in the process that can open it.
  const proxy = cfg.proxy
    ? await ReleaseProxy.start({
        db,
        vault,
        attest,
        forge,
        bytes: dirArtifacts(cfg.artifactDir),
        githubToken: async () => cfg.githubPublishToken,
        bindHost: cfg.proxy.bind,
        port: cfg.proxy.port,
        ...(cfg.proxy.advertiseHost ? { advertiseHost: cfg.proxy.advertiseHost } : {}),
        ...(cfg.proxy.advertisePort ? { advertisePort: cfg.proxy.advertisePort } : {}),
        ...(cfg.proxy.advertiseAddresses
          ? { advertiseAddresses: cfg.proxy.advertiseAddresses }
          : {}),
        ...(cfg.proxy.tlsCertFile && cfg.proxy.tlsKeyFile
          ? {
              tls: {
                cert: readFileSync(cfg.proxy.tlsCertFile, "utf8"),
                key: readFileSync(cfg.proxy.tlsKeyFile, "utf8"),
              },
            }
          : {}),
        log,
      })
    : undefined;
  if (proxy) log(`release proxy listening on ${proxy.host}:${proxy.port}`);
  // How the worker asks for a job's proxy credential: the lane re-verifies each request itself.
  const configKey = cfg.channel
    ? (cfg.channel.configKey ??
      (cfg.channel.configKeyFile
        ? readFileSync(cfg.channel.configKeyFile, "utf8").trim()
        : undefined))
    : undefined;
  const channel =
    proxy && cfg.channel
      ? await startChannel({
          db,
          proxy,
          key: channelKey(cfg.channel),
          ...(configKey
            ? {
                config: {
                  key: configKey,
                  lane: new LaneConfig({
                    attest,
                    vault,
                    db,
                    githubCredential: cfg.githubPublishToken !== undefined,
                    keys: fileKeyVault(keysDir(resolve(cfg.dataDir)), masterKey),
                  }),
                },
              }
            : {}),
          listen: cfg.channel.tcp
            ? {
                tcp: {
                  host: cfg.channel.tcp.host,
                  port: cfg.channel.tcp.port,
                  tls: {
                    cert: readFileSync(cfg.channel.tcp.certFile, "utf8"),
                    key: readFileSync(cfg.channel.tcp.keyFile, "utf8"),
                    ca: readFileSync(cfg.channel.tcp.caFile, "utf8"),
                  },
                },
              }
            : { unix: cfg.channel.socket || join(resolve(cfg.dataDir), "channel.sock") },
          log,
        })
      : undefined;
  if (channel) log("release channel listening");
  // A freeze revokes the credentials of running publish jobs, not only the next request.
  const sweep = proxy
    ? setInterval(() => {
        void proxy.sweepFrozen().catch((e) => log(`sweep failed: ${String(e)}`));
        void proxy.sweepApprovals().catch((e) => log(`sweep failed: ${String(e)}`));
      }, cfg.pollMs)
    : undefined;
  lane.start(cfg.pollMs);
  log("release lane started");
  return {
    stop() {
      if (sweep) clearInterval(sweep);
      channel?.stop();
      void proxy?.stop();
      lane.stop();
      attest.close();
      db.close();
    },
  };
}
