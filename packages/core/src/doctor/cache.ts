// A doctor run opens files, probes the release channel and calls the provider's API, so a caller
// that can trigger runs must not be able to trigger them in a loop. This shares one run among
// concurrent callers and serves its result again until `ttlMs` has passed.
import type { DoctorReport } from "./types";

export const DOCTOR_CACHE_MS = 30_000;

export function cachedDoctor(
  run: () => Promise<DoctorReport>,
  ttlMs: number = DOCTOR_CACHE_MS,
  now: () => number = Date.now,
): () => Promise<DoctorReport> {
  let last: { at: number; report: DoctorReport } | undefined;
  let inflight: Promise<DoctorReport> | undefined;
  return async () => {
    if (last && now() - last.at < ttlMs) return last.report;
    inflight ??= run()
      .then((report) => {
        last = { at: now(), report };
        return report;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}
