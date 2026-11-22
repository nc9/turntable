// Display formatting for artifacts. What may consume an artifact is the server's decision
// (`check_artifact_consumption`); nothing here decides it.

export function shortDigest(sha256: string): string {
  return `${sha256.slice(0, 12)}…${sha256.slice(-6)}`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `18.4 MB`; decimal units. */
export function formatSize(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${UNITS[i]}`;
}
