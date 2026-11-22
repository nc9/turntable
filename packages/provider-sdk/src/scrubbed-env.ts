// The environment a child process of the server gets. The server's own environment holds the
// master key path, bootstrap token hash, API tokens and cloud credentials; a child (git, tar,
// docker) needs none of them, and one that is compromised or merely verbose must not leak them.
// So children get an allowlist, plus named extras per call site, never a copy of process.env.

/** Variables every child may inherit: locale, time zone, a path and a temp dir. */
const BASE_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"] as const;

/** Extras the docker CLI needs to find its daemon and config. */
export const DOCKER_ENV_PASSTHROUGH = [
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "XDG_RUNTIME_DIR",
] as const;

/** Names that can never be passed through, whoever asks. */
const NEVER = /^LONGSHORE_|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|MASTER|API_?KEY|CREDENTIAL/i;

/**
 * Builds a child environment: the base allowlist from `source`, then each name in `passthrough`
 * that is set in `source`, then `set` (explicit values win). Throws if `passthrough` or `set`
 * names a variable that looks like a credential or a Longshore setting.
 */
export function scrubbedEnv(
  set: Record<string, string> = {},
  passthrough: readonly string[] = [],
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  for (const name of passthrough) {
    if (NEVER.test(name)) throw new Error(`refusing to pass ${name} to a child process`);
  }
  for (const name of Object.keys(set)) {
    if (name.startsWith("LONGSHORE_"))
      throw new Error(`refusing to pass ${name} to a child process`);
  }
  const out: Record<string, string> = {};
  for (const name of [...BASE_ALLOW, ...passthrough]) {
    const v = source[name];
    if (v !== undefined) out[name] = v;
  }
  return { ...out, ...set };
}
