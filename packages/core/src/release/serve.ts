// `longshore serve --roles release`: the release lane as its own process.
import { join, resolve } from "node:path";
import { LocalSigner } from "@longshore/signer";
import { createApprovalVerifier } from "../approvals/verifier";
import { type Db, ensureInstance, openDatabase } from "../db";
import { getRunArtifactsByName } from "../db/repos";
import { loadMasterKey } from "../secrets/crypto";
import { SigningService } from "../signing";
import { releaseConfigFromEnv } from "../roles";
import { AttestationStore } from "./attest";
import { dirArtifacts } from "./artifacts";
import { githubForge } from "./forge";
import { fileKeyVault } from "./key-vault";
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
  const lane = new ReleaseLane({
    db,
    forge: githubForge({ token: cfg.githubToken }),
    bytes: dirArtifacts(cfg.artifactDir),
    records,
    attest,
    signer,
    owner: `release-lane:${process.pid}`,
    log,
  });
  lane.start(cfg.pollMs);
  log("release lane started");
  return {
    stop() {
      lane.stop();
      attest.close();
      db.close();
    },
  };
}
