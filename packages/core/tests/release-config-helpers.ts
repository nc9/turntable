// A real release-lane config channel for tests (#541): the lane's file, its vault view and a
// listener on a unix socket under its own request key, a client for the main side, and a software
// passkey enrolled as an approver, so the lane ops run end to end. The caller is a web session of
// an owner of the operator org (the harness's `orgId`) with that passkey. Only the clock and the
// authenticator are software; the rows, the channel, the MACs and the dispatcher are real.
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMember, createUser, getOrgById, insertApprover, type Db } from "../src/db";
import * as schema from "../src/db/schema";
import type { WebSessions } from "../src/auth/web-sessions";
import { dispatch, registry, type DispatchEnv } from "../src/ops";
import { secretDigest } from "../src/ops/lane-target";
import type { AttestationStore } from "../src/release/attest";
import { startChannel, type RunningChannel } from "../src/release/channel";
import { createLaneConfigClient } from "../src/release/channel-client";
import { LaneConfig } from "../src/release/config";
import type { FileKeyVault } from "../src/release/key-vault";
import type { ReleaseProxy } from "../src/release/proxy";
import { SecretVault } from "../src/secrets/vault";

let nextId = 1001;
export const RP = { rpId: "ci.example.test", origins: ["https://ci.example.test"] };
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** A software passkey: ES256, user-verified, with a counter that advances. */
export function passkey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(32);
  let counter = 0;
  return {
    credentialId: credentialId.toString("base64url"),
    spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    assert(challenge: string) {
      counter += 1;
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin: RP.origins[0] }),
      );
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(RP.rpId), Buffer.from([0x05]), c]);
      const sig = createSign("sha256")
        .update(Buffer.concat([authData, sha256(clientData)]))
        .sign(privateKey as KeyObject);
      return {
        credential_id: credentialId.toString("base64url"),
        client_data_json: clientData.toString("base64url"),
        authenticator_data: authData.toString("base64url"),
        signature: sig.toString("base64url"),
      };
    },
  };
}

export type StepUp = {
  id: string;
  approver: string;
  signature: ReturnType<ReturnType<typeof passkey>["assert"]>;
};

export type Harness = Awaited<ReturnType<typeof opsHarness>>;

/**
 * `orgId`'s approver passkey, the instance token, and the lane (its file is `attest`, its vault
 * view reads and writes `db`) behind a real channel. `lane: false` leaves the main side with no
 * channel at all (an instance whose lane is not configured).
 */
export async function opsHarness(o: {
  db: Db;
  attest: AttestationStore;
  orgId: string;
  lane?: boolean;
  /** The lane's sealed signing keys; absent, the lane has no release master key. */
  keys?: FileKeyVault;
  /** Console calls made while this harness runs are kept here (the server log capture). */
  captureConsole?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "tt-cfg-"));
  const masterKey = randomBytes(32);
  const vault = new SecretVault({ db: o.db, masterKey, lane: "release" });
  const laneConfig = new LaneConfig({
    attest: o.attest,
    vault,
    db: o.db,
    githubCredential: true,
    ...(o.keys ? { keys: o.keys } : {}),
  });
  const requestKey = randomBytes(32).toString("hex");
  const configKey = randomBytes(32).toString("hex");
  const sock = join(dir, "c.sock");
  const logs: string[] = [];
  let channel: RunningChannel | undefined;
  if (o.lane !== false) {
    channel = await startChannel({
      db: o.db,
      proxy: {} as ReleaseProxy,
      key: requestKey,
      config: { key: configKey, lane: laneConfig },
      listen: { unix: sock },
      log: (m) => logs.push(m),
    });
  }
  const client =
    o.lane === false
      ? undefined
      : createLaneConfigClient({ target: { unix: sock }, key: configKey });

  const operator = (await getOrgById(o.db, o.orgId))!;
  const live: Record<string, { userId: string; hash: string }> = {};
  const devices: Record<string, ReturnType<typeof passkey>> = {};
  /**
   * A person with a web session. `memberships` are their orgs and roles; `approverIn` lists the
   * orgs where they enrol the passkey as an approver (default: every org they are in).
   */
  async function person(p: {
    login: string;
    memberships: { orgId: string; role: "owner" | "admin" | "member" | "viewer" }[];
    approverIn?: string[];
  }) {
    const user = await createUser(o.db, { displayName: p.login });
    const githubUserId = String(nextId++);
    await o.db.run((x) =>
      x.orm
        .insert(schema.githubIdentities)
        .values({ githubUserId, userId: user.id, login: p.login }),
    );
    const dev = passkey();
    for (const m of p.memberships) {
      await addMember(o.db, { orgId: m.orgId }, { userId: user.id, role: m.role });
    }
    for (const orgId of p.approverIn ?? p.memberships.map((m) => m.orgId)) {
      await insertApprover(
        o.db,
        orgId,
        {
          person: p.login,
          forgeLogin: p.login,
          githubUserId,
          kind: "webauthn",
          credentialId: dev.credentialId,
          publicKey: dev.spki,
          alg: "ES256",
          createdBy: "test",
        },
        Date.now(),
      );
    }
    const cookie = `cookie-${p.login}-${randomBytes(12).toString("hex")}`;
    live[cookie] = { userId: user.id, hash: `hash-${p.login}` };
    devices[cookie] = dev;
    return { cookie, userId: user.id, device: dev };
  }
  const owner = await person({
    login: "alice",
    memberships: [{ orgId: o.orgId, role: "owner" }],
  });
  const device = owner.device;

  const clock = { now: Date.now() };
  const env: DispatchEnv = {
    registry,
    db: o.db,
    allowInstance: true,
    sessions: { resolve: async (c: string) => live[c] } as unknown as WebSessions,
    webauthn: RP,
    operatorOrgSlug: operator.slug,
    now: () => clock.now,
    ...(client ? { releaseConfig: client } : {}),
  };
  /** A call as a person (default: the operator org's owner), naming the operator org. */
  const call = (
    name: string,
    input: Record<string, unknown>,
    stepUp?: StepUp,
    cookie: string = owner.cookie,
  ) =>
    dispatch(
      env,
      { kind: "session", cookie },
      name,
      stepUp ? { org: operator.slug, ...input, step_up: stepUp } : { org: operator.slug, ...input },
    );

  /**
   * A step-up for `action` and `input`, signed by the caller's own passkey. A secret value never
   * goes into it: its digest does, which is what a real client sends.
   */
  async function stepUpFor(
    action: string,
    input: Record<string, unknown>,
    over: { device?: ReturnType<typeof passkey>; cookie?: string } = {},
  ): Promise<StepUp> {
    const asked: Record<string, unknown> = { ...input };
    for (const f of registry.get(action)!.secretInputFields) {
      asked[`${f}_sha256`] = secretDigest(f, String(asked[f]));
      delete asked[f];
    }
    const cookie = over.cookie ?? owner.cookie;
    const r = await call(
      "session_step_up_challenge",
      { action, input: { org: operator.slug, ...asked } },
      undefined,
      cookie,
    );
    if (!r.ok) throw new Error(`challenge refused: ${r.error.message}`);
    const out = r.output as {
      step_up_id: string;
      challenge: string;
      passkeys: { approver: string }[];
    };
    return {
      id: out.step_up_id,
      approver: out.passkeys[0]!.approver,
      signature: (over.device ?? devices[cookie] ?? device).assert(out.challenge),
    };
  }
  /** The call with a fresh step-up for exactly this input. */
  const signedCall = async (name: string, input: Record<string, unknown>) =>
    call(name, input, await stepUpFor(name, input));

  return {
    dir,
    sock,
    configKey,
    vault,
    laneConfig,
    client,
    device,
    env,
    clock,
    logs,
    cookie: owner.cookie,
    operator,
    person,
    call,
    stepUpFor,
    signedCall,
    dispose() {
      channel?.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
