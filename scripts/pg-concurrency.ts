/** `TURNTABLE_PG_TEST_CONCURRENCY`: an integer 1 to 8; unset or empty means 1. */
export function parsePgConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const v = raw.trim();
  if (!/^[1-8]$/.test(v)) {
    throw new Error(`TURNTABLE_PG_TEST_CONCURRENCY must be an integer from 1 to 8, got "${raw}"`);
  }
  return Number(v);
}
