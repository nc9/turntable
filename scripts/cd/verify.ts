// Post-deploy verification: poll /healthz until it is ok and reports the target sha.
export interface VerifyDeps {
  fetch(url: string): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface VerifyOptions {
  baseUrl: string;
  targetSha: string;
  timeoutMs?: number;
  pollMs?: number;
}

export type VerifyResult =
  { ok: true; elapsedMs: number } | { ok: false; reason: string; elapsedMs: number };

export async function verifyDeploy(deps: VerifyDeps, opts: VerifyOptions): Promise<VerifyResult> {
  const started = deps.now();
  const deadline = started + (opts.timeoutMs ?? 10 * 60_000);
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/healthz`;
  let last = "no response";
  for (;;) {
    try {
      const res = await deps.fetch(url);
      if (!res.ok) last = `healthz returned ${res.status}`;
      else {
        const body = (await res.json()) as { ok?: unknown; version?: unknown; build_sha?: unknown };
        const seen = typeof body.build_sha === "string" ? body.build_sha : String(body.version);
        if (body.ok !== true) last = "healthz is not ok";
        else if (body.build_sha === opts.targetSha || body.version === opts.targetSha) {
          return { ok: true, elapsedMs: deps.now() - started };
        } else last = `healthz reports ${seen}, expected ${opts.targetSha}`;
      }
    } catch (e) {
      last = `healthz unreachable: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (deps.now() >= deadline) {
      return { ok: false, reason: `timed out: ${last}`, elapsedMs: deps.now() - started };
    }
    await deps.sleep(opts.pollMs ?? 5_000);
  }
}
