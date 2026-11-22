// `longshore serve --roles release`: the release lane as its own process.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LocalSigner } from "@longshore/signer";
import { createApprovalVerifier } from "../approvals/verifier";
import { type Db, ensureInstance, openDatabase } from "../db";
import { getRunArtifactsByName } from "../db/repos";
import { loadMasterKey } from "../secrets/crypto";
import { SecretVault } from "../secrets/vault";
import { SigningService } from "../signing";
import { releaseConfigFromEnv } from "../roles";
import { AttestationStore } from "./attest";
import { dirArtifacts } from "./artifacts";
import { githubForge } from "./forge";
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
    signer: { signRelease: (scope, req) => service.signRelease(scope, req) },
    records: {
      async recorded(scope, runId, names) {
        const rows = await getRunArtifactsByName(db, scope, runId, names);
        return rows.map((a) => ({ name: a.name, sha256: a.sha256 }));
      },
    },
  };
};

export async function serveRelease(
  values: { "data-dir": string },
  wiring: WiringFactory = signingWiring,
  env: Record<string, string | undefined> = process.env,
): Promise<{ stop(): void }> {
  const cfg = releaseConfigFromEnv(env);
  // The lane's own master key, in its own file: the main process neither has nor can read it.
  const masterKey = loadMasterKey(cfg.masterKeyFile);
  const log = (m: string) => console.log(`[longshore release] ${m}`);
  // Requests come from the main database; everything the lane itself holds is in its own files.
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  await ensureInstance(db);
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
  const forge = githubForge({ token: cfg.githubToken });
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
  const channel =
    proxy && cfg.channel
      ? await startChannel({
          db,
          proxy,
          key: readFileSync(cfg.channel.keyFile, "utf8").trim(),
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
