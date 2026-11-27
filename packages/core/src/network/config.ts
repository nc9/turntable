import { MAX_DEGRADED_MS } from "./health";

export type NetworkProbeConfig = {
  enabled: boolean;
  maxDegradedMs: number;
  /** The forge probe URL, from the poller's API base (the host ingest talks to). */
  forgeUrl: string;
};

/**
 * The degraded-network probe's settings (#698). `TURNTABLE_NETWORK_PROBE` is `auto` (default: on
 * for the daytona provider, where the control plane is remote from its sandboxes and a lost
 * network is a real, recurring failure; off for docker and local, where a host with restricted
 * egress would otherwise probe a target it is not meant to reach), `on` or `off`.
 * `TURNTABLE_NETWORK_MAX_DEGRADED_SECONDS` (60 to 86400, default 900) caps how long one degraded
 * window may hold claims. Bad values throw.
 */
export function networkProbeConfig(
  env: Record<string, string | undefined>,
  providerName: string,
  apiBaseUrl: string,
): NetworkProbeConfig {
  const mode = (env.TURNTABLE_NETWORK_PROBE?.trim().toLowerCase() || "auto") as string;
  if (mode !== "auto" && mode !== "on" && mode !== "off")
    throw new Error("TURNTABLE_NETWORK_PROBE must be auto, on or off");
  const raw = env.TURNTABLE_NETWORK_MAX_DEGRADED_SECONDS?.trim();
  let maxDegradedMs = MAX_DEGRADED_MS;
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 60 || n > 86_400)
      throw new Error(
        "TURNTABLE_NETWORK_MAX_DEGRADED_SECONDS must be a whole number from 60 to 86400",
      );
    maxDegradedMs = n * 1000;
  }
  return {
    enabled: mode === "on" || (mode === "auto" && providerName === "daytona"),
    maxDegradedMs,
    forgeUrl: `${apiBaseUrl.replace(/\/+$/, "")}/rate_limit`,
  };
}
