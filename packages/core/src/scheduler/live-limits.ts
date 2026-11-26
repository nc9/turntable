// The sandbox limits as live settings (#661): the scheduler's two caps and the Daytona provider's
// two, read through the settings registry at claim and create time. A value is cached for a few
// seconds (every claim would otherwise be four reads) and dropped at once when this process
// changes a setting; another process's change shows within the cache time. Never stops anything:
// a lower value only holds new claims and creates.
import type { Db } from "../db";
import {
  providerDaytonaCpuLimitSetting,
  providerDaytonaMaxLiveSetting,
  schedulerGlobalCapSetting,
  schedulerOrgCapSetting,
} from "../settings/definitions";
import { ambientSettings } from "../settings/ambient";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";

export type SandboxLimits = {
  globalCap: number;
  orgCap: number;
  daytona: { maxLive: number; cpuLimit: number };
};

/** How long a read is reused, in ms. */
export const LIMITS_CACHE_MS = 5_000;

let epoch = 0;

/** Drops every cached limit: called after a setting is written in this process. */
export function invalidateSandboxLimits(): void {
  epoch++;
}

export class LiveLimits {
  #cache: { at: number; epoch: number; value: SandboxLimits } | undefined;

  readonly #db: Db;
  readonly #settings: () => SettingsRuntime;

  constructor(db: Db, settings: () => SettingsRuntime = ambientSettings) {
    this.#db = db;
    this.#settings = settings;
  }

  /** The effective limits, read through the registry (env, `turntable.toml`, database, default). */
  async read(now: number = Date.now()): Promise<SandboxLimits> {
    const c = this.#cache;
    if (c && c.epoch === epoch && Math.abs(now - c.at) < LIMITS_CACHE_MS) return c.value;
    const rt = this.#settings();
    const get = async (key: string): Promise<number> =>
      (await resolveSetting(rt, this.#db, key)).value as number;
    const value: SandboxLimits = {
      globalCap: await get(schedulerGlobalCapSetting.key),
      orgCap: await get(schedulerOrgCapSetting.key),
      daytona: {
        maxLive: await get(providerDaytonaMaxLiveSetting.key),
        cpuLimit: await get(providerDaytonaCpuLimitSetting.key),
      },
    };
    this.#cache = { at: now, epoch, value };
    return value;
  }

  /** The last value read, for a provider's synchronous limits hook. Undefined before the first read. */
  last(): SandboxLimits | undefined {
    return this.#cache?.value;
  }
}
