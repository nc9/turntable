import type { Provider } from "@longshore/provider-sdk";

/**
 * Egress canary. When a job's policy is `none`, the sandbox must really have no way out. Before
 * the job runs, a short command inside the sandbox tries to open a connection to a public address
 * and to the cloud metadata address; if either connects, the policy is not being enforced and
 * the job must not run (it would hold secrets or untrusted code with a network).
 *
 * Addresses are IPs, so DNS being down cannot hide a hole. Exit codes of the probe:
 *   0   every target is unreachable (verified)
 *   10  a target answered (a breach)
 *   125 no tool to test with: curl, wget, nc or bash (unknown)
 */
export const CANARY_TARGETS: readonly string[] = ["1.1.1.1:80", "169.254.169.254:80"];

const PROBE_SH = String.raw`
tool=
if command -v curl >/dev/null 2>&1; then tool=curl
elif command -v wget >/dev/null 2>&1; then tool=wget
elif command -v nc >/dev/null 2>&1; then tool=nc
elif command -v bash >/dev/null 2>&1; then tool=bash
fi
[ -n "$tool" ] || exit 125
for t in "$@"; do
  h=\${t%:*}; p=\${t##*:}
  case $tool in
    curl)
      code=$(curl -s -m 3 --connect-timeout 3 -o /dev/null -w '%{http_code}' "http://$h:$p/" 2>/dev/null)
      [ -n "$code" ] && [ "$code" != 000 ] && { echo "reachable $t"; exit 10; } ;;
    wget)
      wget -q -T 3 -t 1 -O /dev/null "http://$h:$p/" >/dev/null 2>&1; rc=$?
      # 0: fetched; 8: the server answered with an error. Either way something answered.
      [ $rc -eq 0 ] || [ $rc -eq 8 ] && { echo "reachable $t"; exit 10; } ;;
    nc)
      nc -z -w 3 "$h" "$p" >/dev/null 2>&1 && { echo "reachable $t"; exit 10; } ;;
    bash)
      timeout 3 bash -c "exec 3<>/dev/tcp/$h/$p" >/dev/null 2>&1 && { echo "reachable $t"; exit 10; } ;;
  esac
done
exit 0
`.replace(/\\\$/g, "$");

export type CanaryVerdict =
  | { kind: "blocked" }
  | { kind: "reachable"; target: string }
  | { kind: "unknown"; why: string };

export type CanaryOptions = {
  targets?: readonly string[];
  pollMs?: number;
  /** Wall clock for the probe, seconds. Default 30. */
  timeoutSeconds?: number;
  signal?: AbortSignal | undefined;
};

const dec = new TextDecoder();

/** Runs the canary inside `sandboxId` through the provider's detached exec. */
export async function probeEgress(
  provider: Provider,
  sandboxId: string,
  o: CanaryOptions = {},
): Promise<CanaryVerdict> {
  const timeoutSeconds = o.timeoutSeconds ?? 30;
  const { execId } = await provider.exec.start(sandboxId, {
    argv: ["sh", "-c", PROBE_SH, "canary", ...(o.targets ?? CANARY_TARGETS)],
    timeoutSeconds,
  });
  const deadline = Date.now() + (timeoutSeconds + 15) * 1000;
  for (;;) {
    if (o.signal?.aborted) return { kind: "unknown", why: "cancelled" };
    const s = await provider.exec.status(sandboxId, execId);
    if (s.state !== "running") {
      if (s.state !== "exited") return { kind: "unknown", why: `probe ${s.state}` };
      if (s.exitCode === 0) return { kind: "blocked" };
      if (s.exitCode === 125)
        return { kind: "unknown", why: "no curl, wget, nc or bash in the image" };
      if (s.exitCode === 10) {
        const logs = await provider.exec.logs(sandboxId, execId, { fromOffset: 0, maxBytes: 4096 });
        const m = /reachable (\S+)/.exec(dec.decode(logs.bytes));
        return { kind: "reachable", target: m?.[1] ?? "a target" };
      }
      return { kind: "unknown", why: `probe exited ${s.exitCode}` };
    }
    if (Date.now() > deadline) return { kind: "unknown", why: "probe timed out" };
    await Bun.sleep(o.pollMs ?? 250);
  }
}
