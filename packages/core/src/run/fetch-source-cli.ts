// `longshore fetch-source <owner/name> <sha>`: does exactly what the worker does to get a run's
// commit (gitRepoSource: an in-process git fetch at depth 1 over https, every object verified, the
// tree and `.git` written and packed) and says what it got. It runs no git or tar binary. It is
// the image's smoke test of a real checkout, and a way for an operator to check that a host can
// reach GitHub and that a commit can be fetched, without starting a run.
import { parseArgs } from "node:util";
import { readTarGz } from "@longshore/act-runner";
import { gitRepoSource } from "../scheduler/act-runner";

export const FETCH_SOURCE_USAGE = `Usage: longshore fetch-source <owner/name> <sha> [--file <path>]

Fetches that commit of a public GitHub repository the way a worker does, and prints one line:
  ok <sha> files=<n> tarball=<bytes>[ file=<path>:<bytes>]
--file also reads that repository file through the worker's safe reader. Exit status 1 on failure.`;

export async function fetchSourceCommand(
  args: string[],
  out: (s: string) => void = (s) => console.log(s),
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { file: { type: "string" }, help: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    out(FETCH_SOURCE_USAGE);
    return 0;
  }
  const [repo, sha = ""] = positionals;
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo ?? "");
  if (!m || !/^[0-9a-fA-F]{40}$/.test(sha)) {
    console.error(FETCH_SOURCE_USAGE);
    return 2;
  }
  try {
    const co = await gitRepoSource().checkout({ sha } as never, {
      owner: m[1] as string,
      repo: m[2] as string,
    });
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
    console.error(`fetch-source failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
