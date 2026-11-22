// Supply-chain pin check (#51): everything Longshore fetches at build or run time is pinned by an
// immutable reference. A GitHub Action is pinned by commit SHA, a container image by sha256
// digest, and a binary downloaded in a Dockerfile or in code by a checksum. A tag or a branch can
// be moved by whoever controls the upstream; a digest cannot.
//
//   bun run scripts/check-pins.ts            (exits 1 and lists every unpinned reference)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Finding {
  file: string;
  line: number;
  what: string;
  text: string;
}
export interface Source {
  path: string;
  text: string;
}

const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}\b/;

/**
 * The lines of a source. One carrying `pin-ok: <reason>` is excused by whoever wrote it, for a
 * thing that is not fetched from upstream (an image this same job just built).
 */
const lines = (s: Source): { n: number; text: string }[] =>
  s.text
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => !/pin-ok:\s*\S/.test(l.text));
/** A line with its trailing comment removed (`#` after whitespace, or at the start). */
const code = (text: string): string => text.replace(/(^|\s)#.*$/, "");

/** `uses:` in a workflow or composite action: commit SHA for remote actions, digest for docker://. */
export function checkUses(s: Source): Finding[] {
  const out: Finding[] = [];
  for (const { n, text } of lines(s)) {
    const m = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(code(text));
    if (!m) continue;
    const ref = m[1]!.replaceAll(/^["']|["']$/g, "");
    if (ref.startsWith("./")) continue; // an action in this repository
    if (ref.startsWith("docker://")) {
      if (!DIGEST.test(ref))
        out.push({
          file: s.path,
          line: n,
          what: "docker:// action is not pinned by digest",
          text: text.trim(),
        });
      continue;
    }
    const at = ref.lastIndexOf("@");
    if (at < 0 || !SHA40.test(ref.slice(at + 1)))
      out.push({
        file: s.path,
        line: n,
        what: "action is not pinned by a full commit SHA",
        text: text.trim(),
      });
  }
  return out;
}

const IMAGE_ENV = /^\s*(?:TT_[A-Z_]*IMAGE|[A-Z_]*_IMAGE|image|container):\s*["']?([^\s"'#]+)/;

/** Images named in a workflow: `image:`, `container:`, `*_IMAGE` values, `docker run|pull` arguments. */
export function checkWorkflowImages(s: Source): Finding[] {
  const out: Finding[] = [];
  const bad = (n: number, text: string, what: string): void => {
    out.push({ file: s.path, line: n, what, text: text.trim() });
  };
  for (const { n, text } of lines(s)) {
    const c = code(text);
    const env = IMAGE_ENV.exec(c);
    // Values built from our own pushed digest (`ghcr.io/x@${{ ... }}`) or other expressions are skipped.
    if (env && !env[1]!.includes("${{") && !DIGEST.test(env[1]!))
      bad(n, text, "image is not pinned by digest");
    const run = /\bdocker\s+(?:run|pull|create)\b(.*)$/.exec(c);
    if (run) {
      const image = run[1]!
        .split(/\s+/)
        .filter((w) => w !== "" && !w.startsWith("-"))
        .find((w) => /^[a-z0-9][\w.-]*(\/[\w.-]+)*(:[\w.-]+)?(@sha256:[0-9a-f]{64})?$/.test(w));
      if (image && !image.includes("$") && !DIGEST.test(image))
        bad(n, text, "docker image is not pinned by digest");
    }
  }
  return out;
}

/** A Dockerfile: base images by digest, and every curl or wget download checked against a checksum. */
export function checkDockerfile(s: Source): Finding[] {
  const out: Finding[] = [];
  const stages = new Set<string>();
  const defaults = new Map<string, string>();
  const all = lines(s);
  for (const { text } of all) {
    const a = /^\s*ARG\s+([A-Z0-9_]+)=(\S+)/.exec(text);
    if (a) defaults.set(a[1]!, a[2]!);
  }
  for (const { n, text } of all) {
    const f = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(text);
    if (!f) continue;
    let ref = f[1]!;
    const v = /^\$\{?([A-Z0-9_]+)\}?$/.exec(ref);
    if (v) ref = defaults.get(v[1]!) ?? ref;
    if (f[2]) stages.add(f[2]);
    if (ref === "scratch" || stages.has(ref)) continue;
    if (!DIGEST.test(ref))
      out.push({
        file: s.path,
        line: n,
        what: "base image is not pinned by digest",
        text: text.trim(),
      });
  }
  // A RUN instruction (with its continuation lines) that downloads must verify what it got.
  const raw = s.text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const start = i;
    let instruction = raw[i]!;
    while (raw[i]!.trimEnd().endsWith("\\") && i + 1 < raw.length) instruction += ` ${raw[++i]!}`;
    if (!/^\s*RUN\b/.test(instruction) || /pin-ok:\s*\S/.test(instruction)) continue;
    if (
      /\b(curl|wget)\b/.test(instruction) &&
      !/\b(sha256sum|sha512sum|shasum)\b/.test(instruction)
    )
      out.push({
        file: s.path,
        line: start + 1,
        what: "a download in a RUN has no checksum verification",
        text: instruction.trim().slice(0, 120),
      });
  }
  return out;
}

/**
 * Binaries fetched by code at run time (the act release): every entry of a release table needs a
 * sha256, and the code must verify it. The table is found by its `sha256:` literals.
 */
export function checkRuntimeDownloads(s: Source): Finding[] {
  const out: Finding[] = [];
  const hashes = [...s.text.matchAll(/sha256:\s*"([^"]*)"/g)];
  for (const m of hashes) {
    if (!/^[0-9a-f]{64}$/.test(m[1]!))
      out.push({
        file: s.path,
        line: s.text.slice(0, m.index).split("\n").length,
        what: "a pinned download has no valid sha256",
        text: m[0],
      });
  }
  if (
    hashes.length > 0 &&
    !/createHash\(["']sha256["']\)|sha256/i.test(s.text.replace(/sha256:\s*"[^"]*"/g, ""))
  )
    out.push({
      file: s.path,
      line: 1,
      what: "the download is never verified against its sha256",
      text: "",
    });
  return out;
}

/** `bun-version` and similar toolchain pins must be exact versions, never `latest` or a range. */
export function checkToolVersions(s: Source): Finding[] {
  const out: Finding[] = [];
  for (const { n, text } of lines(s)) {
    const m = /^\s*bun-version:\s*["']?([^\s"'#]+)/.exec(code(text));
    if (m && !/^\d+\.\d+\.\d+$/.test(m[1]!))
      out.push({
        file: s.path,
        line: n,
        what: "toolchain version is not exact",
        text: text.trim(),
      });
  }
  return out;
}

const walk = (dir: string, skip: Set<string>): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, skip) : [p];
  });

/** Every check over the files of a checkout. */
export function checkRepo(root: string): Finding[] {
  const skip = new Set(["node_modules", ".git", "dist", "build", "data"]);
  const files = walk(root, skip).map((p) => relative(root, p));
  const read = (path: string): Source => ({ path, text: readFileSync(join(root, path), "utf8") });
  const out: Finding[] = [];
  for (const f of files) {
    if (/^\.github\/(workflows|actions)\/.*\.ya?ml$/.test(f)) {
      const s = read(f);
      out.push(...checkUses(s), ...checkWorkflowImages(s), ...checkToolVersions(s));
    }
    if (/(^|\/)Dockerfile(\..+)?$/.test(f)) out.push(...checkDockerfile(read(f)));
    if (f === "packages/act-runner/src/act-install.ts") out.push(...checkRuntimeDownloads(read(f)));
  }
  return out;
}

if (import.meta.main) {
  const found = checkRepo(join(import.meta.dir, ".."));
  if (found.length === 0) {
    console.log("every fetched component is pinned by digest, commit or checksum");
  } else {
    for (const f of found) console.error(`${f.file}:${f.line}: ${f.what}\n    ${f.text}`);
    console.error(
      `\n${found.length} unpinned reference(s). Pin by digest, commit SHA or checksum.`,
    );
    process.exit(1);
  }
}
