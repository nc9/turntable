// Builds the web UI into packages/ui/dist (HTML, hashed JS/CSS, fonts, icon).
//   bun run --cwd packages/ui build
// The compiled binary embeds these files: see packages/core/src/ui-assets.ts and the wiring notes
// in docs. Exports `buildUi` so scripts/build.ts can call it before `bun build --compile`.
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import tailwind from "bun-plugin-tailwind";

const root = join(import.meta.dir, "..");
export const uiDist = join(root, "dist");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Builds the UI and returns the absolute paths of every emitted file. */
export async function buildUi(opts?: { version: string; sha: string }): Promise<string[]> {
  rmSync(uiDist, { recursive: true, force: true });
  mkdirSync(uiDist, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "src/index.html")],
    outdir: uiDist,
    target: "browser",
    publicPath: "/",
    minify: true,
    sourcemap: "none",
    plugins: [tailwind],
    // Stable, content-hashed names; the server serves them as immutable.
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.TURNTABLE_UI_BACKEND": JSON.stringify(process.env.TURNTABLE_UI_BACKEND ?? ""),
      "process.env.TURNTABLE_UI_VERSION": JSON.stringify(opts?.version ?? ""),
      "process.env.TURNTABLE_UI_SHA": JSON.stringify(opts?.sha ?? ""),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("ui build failed");
  }
  return walk(uiDist);
}

if (import.meta.main) {
  const files = await buildUi();
  let total = 0;
  for (const f of files) {
    const size = statSync(f).size;
    total += size;
    console.log(`${relative(uiDist, f).padEnd(48)} ${(size / 1024).toFixed(1)} KiB`);
  }
  console.log(`${files.length} files, ${(total / 1024).toFixed(0)} KiB`);
}
