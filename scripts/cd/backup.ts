// Platform volume backup for CD: create, wait for it to appear, prune to the newest N.
// The GraphQL client, the clock and the sleep are injected.

export type Gql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

export interface Backup {
  id: string;
  createdAt: string;
}

export interface BackupDeps {
  gql: Gql;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface BackupOptions {
  volumeInstanceId: string;
  /** Backups to keep, including the new one. Default 3. */
  keep?: number;
  /** Wait for the new backup, ms. Default 15 min. */
  appearTimeoutMs?: number;
  pollMs?: number;
  /** Retries of a deletion the platform refuses as already in progress. */
  deleteRetries?: number;
  /** Wait for each deletion to take effect, ms. */
  deleteTimeoutMs?: number;
}

export interface BackupResult {
  backupId: string;
  createdAt: string;
  deleted: string[];
  durationMs: number;
}

const CREATE = `mutation($volumeInstanceId: String!) { volumeInstanceBackupCreate(volumeInstanceId: $volumeInstanceId) { workflowId } }`;
const LIST = `query($volumeInstanceId: String!) { volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) { id createdAt } }`;
const DELETE = `mutation($volumeInstanceBackupId: String!, $volumeInstanceId: String!) { volumeInstanceBackupDelete(volumeInstanceBackupId: $volumeInstanceBackupId, volumeInstanceId: $volumeInstanceId) { workflowId } }`;

const time = (b: Backup): number => Date.parse(b.createdAt);

async function list(deps: BackupDeps, volumeInstanceId: string): Promise<Backup[]> {
  const r = await deps.gql<{ volumeInstanceBackupList: Backup[] }>(LIST, { volumeInstanceId });
  return r.volumeInstanceBackupList;
}

export async function createAndPrune(deps: BackupDeps, opts: BackupOptions): Promise<BackupResult> {
  const keep = opts.keep ?? 3;
  if (!Number.isInteger(keep) || keep < 1) throw new Error("keep must be an integer of at least 1");
  const pollMs = opts.pollMs ?? 5_000;
  const started = deps.now();
  const vol = opts.volumeInstanceId;

  await deps.gql<{ volumeInstanceBackupCreate: { workflowId: string } }>(CREATE, {
    volumeInstanceId: vol,
  });

  // Wait for a backup newer than the start time.
  const appearBy = started + (opts.appearTimeoutMs ?? 15 * 60_000);
  let fresh: Backup | undefined;
  for (;;) {
    const newer = (await list(deps, vol)).filter((b) => time(b) > started);
    fresh = newer.sort((a, b) => time(b) - time(a))[0];
    if (fresh) break;
    if (deps.now() >= appearBy)
      throw new Error("backup did not appear before the timeout; aborting");
    await deps.sleep(pollMs);
  }

  // Prune: oldest first, one at a time, only while more than `keep` exist, never the new one.
  const deleted: string[] = [];
  const retries = opts.deleteRetries ?? 20;
  let attempts = 0;
  for (;;) {
    const all = await list(deps, vol);
    if (all.length <= keep) break;
    const victim = all.filter((b) => b.id !== fresh.id).sort((a, b) => time(a) - time(b))[0];
    if (!victim) break;
    try {
      await deps.gql(DELETE, { volumeInstanceBackupId: victim.id, volumeInstanceId: vol });
    } catch (e) {
      if (/already in progress/i.test(e instanceof Error ? e.message : String(e))) {
        if (++attempts > retries) throw new Error("backup deletion stayed in progress; giving up");
        await deps.sleep(pollMs);
        continue;
      }
      throw e;
    }
    attempts = 0;
    deleted.push(victim.id);
    // Wait until it is gone so the next deletion does not collide with this one.
    const goneBy = deps.now() + (opts.deleteTimeoutMs ?? 5 * 60_000);
    while ((await list(deps, vol)).some((b) => b.id === victim.id)) {
      if (deps.now() >= goneBy)
        throw new Error(`backup ${victim.id} was not deleted before the timeout`);
      await deps.sleep(pollMs);
    }
  }
  return {
    backupId: fresh.id,
    createdAt: fresh.createdAt,
    deleted,
    durationMs: deps.now() - started,
  };
}
