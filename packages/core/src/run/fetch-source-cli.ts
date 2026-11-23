// `turntable fetch-source <owner/name> <sha>`: gets a run's commit the way the worker does and says
// what it got. It runs no git or tar binary (an in-process git fetch at depth 1 over https, every
// object verified, the tree and `.git` written, a tarball streamed to disk).
//
// Two modes, one command:
//   - with `--out <file>` it IS the checkout: it does the work in this process, writes the
//     tarball to the file and the tree to `--dir`, and prints one line. The worker runs this as a
//     child process of its own binary, which is how a hostile repository is kept out of the
//     server's process.
//   - without it, it goes through the same path the worker does (a child of this binary, under the
//     same deadline and ceilings) and reports what came back: the image's smoke test of a real
//     checkout, and a way to check that a host can reach GitHub without starting a run.
import { parseArgs } from "node:util";
import { readTarGz } from "@turntable/act-runner";
import { gitRepoSource } from "../scheduler/act-runner";
import { isRepoPart, performCheckout } from "./checkout";
import { checkoutConfigFromEnv } from "./checkout-child";
import { clean, type FetchLimits } from "./git-fetch";

export const FETCH_SOURCE_USAGE = `Usage: turntable fetch-source <owner/name> <sha> [--file <path>]

Fetches that commit of a public GitHub repository the way a worker does, and prints one line:
  ok <sha> files=<n> tarball=<bytes>[ file=<path>:<bytes>]
--file also reads that repository file through the worker's safe reader. Exit status 1 on failure.
The worker's own settings apply (TURNTABLE_CHECKOUT_* in the environment).`;

const NUMERIC_LIMITS = [
  "maxPackBytes",
  "maxObjects",
  "maxInflatedBytes",
  "maxObjectBytes",
  "maxDeltaDepth",
  "maxEntries",
  "maxTreeBytes",
  "maxTarballBytes",
  "timeoutMs",
] as const;

/** Limits given as JSON by the parent: only known keys, only positive whole numbers. */
function parseLimits(json: string | undefined): Partial<FetchLimits> {
  if (json === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("--limits is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("--limits is not an object");
  const out: Partial<FetchLimits> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(NUMERIC_LIMITS as readonly string[]).includes(k))
      throw new Error(`--limits has an unknown key ${clean(k, 30)}`);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
      throw new Error(`--limits ${k} must be a positive whole number`);
    (out as Record<string, number>)[k] = v;
  }
  return out;
}

/**
 * A function to call often. It stops the process (through `onStop`) when the parent that started
 * it is gone, or when its resident memory is over the ceiling (0: no ceiling). The reading is
 * throttled: calling it in a tight loop costs a clock read.
 */
export function makeCheckpoint(o: {
  parentPid: number;
  getParentPid: () => number;
  rss: () => number;
  maxRssBytes: number;
  onStop: (why: string) => void;
  now?: () => number;
}): () => void {
  const now = o.now ?? Date.now;
  let last = 0;
  return () => {
    const t = now();
    if (t - last < 50) return;
    last = t;
    if (o.getParentPid() !== o.parentPid) o.onStop("the server that started this checkout is gone");
    else if (o.maxRssBytes > 0 && o.rss() > o.maxRssBytes)
      o.onStop(`the checkout used more than ${Math.round(o.maxRssBytes / 1048576)} MiB of memory`);
  };
}

export async function fetchSourceCommand(
  args: string[],
  out: (s: string) => void = (s) => console.log(s),
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      file: { type: "string" },
      out: { type: "string" },
      dir: { type: "string" },
      url: { type: "string" },
      limits: { type: "string" },
      "allow-host": { type: "string", multiple: true },
      "max-memory-mib": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    out(FETCH_SOURCE_USAGE);
    return 0;
  }
  const [repo, sha = ""] = positionals;
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo ?? "");
  if (
    !m ||
    !isRepoPart(m[1] as string) ||
    !isRepoPart(m[2] as string) ||
    !/^[0-9a-fA-F]{40}$/.test(sha)
  ) {
    console.error(FETCH_SOURCE_USAGE);
    return 2;
  }
  const owner = m[1] as string;
  const name = m[2] as string;
  const allowHosts = values["allow-host"] ?? [];
  try {
    if (values.out !== undefined) {
      // The checkout itself, as the worker's child process. It stops, without a word, when its
      // parent is gone (an orphan holding a directory and a socket for nobody), and when its own
      // memory passes the ceiling, whichever it notices first: at the checkpoints of its loops and
      // on a timer while it waits on the network.
      const stop = makeCheckpoint({
        parentPid: process.ppid,
        getParentPid: () => process.ppid,
        rss: () => process.memoryUsage.rss(),
        maxRssBytes: Number(values["max-memory-mib"] ?? 0) * 1024 * 1024,
        onStop: (why) => {
          console.error(`fetch-source failed: ${why}`);
          process.exit(70);
        },
      });
      const watchdog = setInterval(stop, 1000);
      const r = await performCheckout({
        owner,
        repo: name,
        sha,
        out: values.out,
        ...(values.dir ? { dir: values.dir } : {}),
        ...(values.url ? { url: values.url } : {}),
        limits: parseLimits(values.limits),
        allowHosts,
        checkpoint: stop,
      });
      clearInterval(watchdog);
      out(`ok ${r.sha} files=${r.files} tarball=${r.tarballBytes}`);
      return 0;
    }
    const co = await gitRepoSource({ allowHosts, config: checkoutConfigFromEnv() }).checkout(
      { sha } as never,
      { owner, repo: name },
    );
    try {
      const files = readTarGz(co.tarball).filter((e) => e.type === "file").length;
      let extra = "";
      if (values.file !== undefined) {
        const text = co.readFile(values.file);
        if (text === undefined) throw new Error(`${values.file} is not in the repository`);
        extra = ` file=${values.file}:${text.length}`;
      }
      out(`ok ${sha.toLowerCase()} files=${files} tarball=${co.tarball.length}${extra}`);
      return 0;
    } finally {
      co.dispose?.();
    }
  } catch (e) {
    console.error(`fetch-source failed: ${clean(e instanceof Error ? e.message : String(e), 300)}`);
    return 1;
  }
}
