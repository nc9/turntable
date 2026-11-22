/** Packs a directory (including .git) into a gzip tarball using the local `tar`. */
export async function tarDirectory(dir: string, entries: string[] = ["."]): Promise<Uint8Array> {
  const proc = Bun.spawn(["tar", "czf", "-", "-C", dir, ...entries], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`tar failed (${code}): ${err}`);
  return out;
}
