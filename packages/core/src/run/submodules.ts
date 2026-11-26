// Submodules for a checkout (#685). What a repository's `.gitmodules` says is hostile input: it
// is read strictly here, every name, path and url is checked, and anything unclear is refused
// (fail closed). Only https urls on github.com resolve to a repository to fetch; nothing here
// fetches anything or holds a credential.
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { foldKey } from "@turntable/act-runner";
import { clean, GitFetchError, safeName } from "./git-fetch";

/** One submodule to fetch: the gitlink's path and pinned commit, and the repository it names. */
export interface SubmoduleSpec {
  /** The `[submodule "<name>"]` name; its git directory is `.git/modules/<name>`. */
  name: string;
  /** The gitlink's path in the tree. */
  path: string;
  sha: string;
  owner: string;
  repo: string;
}

export interface Gitlink {
  path: string;
  sha: string;
}

const PART = /^[A-Za-z0-9_.-]+$/;
const isPart = (s: string): boolean => PART.test(s) && s !== "." && s !== "..";
// control characters are what is being refused
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const show = (s: string): string => JSON.stringify(clean(s, 80));

/** A module name: plain path segments, none that could name `.git` or leave `.git/modules`. */
export function validModuleName(name: string): boolean {
  if (name === "" || name.length > 255 || CONTROL.test(name) || name.startsWith("-")) return false;
  return name.split("/").every((seg) => safeName(seg));
}

/** A path in the tree: relative, plain segments (so no `..`, no `.git`, no absolute path). */
export function validModulePath(path: string): boolean {
  if (path === "" || path.length > 4096 || CONTROL.test(path) || path.startsWith("-")) return false;
  return path.split("/").every((seg) => safeName(seg));
}

interface Section {
  path?: string;
  url?: string;
}

/**
 * The `[submodule "name"]` sections of a `.gitmodules`, as git-config text. Only the plain forms
 * are read: a quoted value with an escape, an inline comment, a continuation line or a repeated
 * key is something git would read one way and this another, so it is refused.
 */
export function parseGitmodules(text: string): Map<string, Section> {
  const out = new Map<string, Section>();
  let current: Section | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const m = /^\[([A-Za-z][A-Za-z0-9.-]*)(?: "([^"\\]*)")?\]$/.exec(line);
      if (!m)
        throw new GitFetchError(`.gitmodules has a section header this cannot read: ${show(line)}`);
      if ((m[1] as string).toLowerCase() === "submodule" && m[2] !== undefined) {
        if (out.has(m[2]))
          throw new GitFetchError(`.gitmodules names the submodule ${show(m[2])} twice`);
        current = {};
        out.set(m[2], current);
      } else {
        current = undefined;
      }
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv) {
      if (/^[A-Za-z][A-Za-z0-9-]*$/.test(line)) continue; // a key with no value
      throw new GitFetchError(`.gitmodules has a line this cannot read: ${show(line)}`);
    }
    if (!current) continue;
    const key = (kv[1] as string).toLowerCase();
    if (key !== "path" && key !== "url") continue;
    let value = (kv[2] as string).trim();
    if (value.endsWith("\\")) throw new GitFetchError(".gitmodules has a continuation line");
    if (value.startsWith('"')) {
      if (!/^"[^"\\]*"$/.test(value))
        throw new GitFetchError(`.gitmodules has a quoted value this cannot read: ${show(value)}`);
      value = value.slice(1, -1);
    } else if (/["\\#;]/.test(value)) {
      throw new GitFetchError(`.gitmodules has a value this cannot read: ${show(value)}`);
    }
    if (current[key] !== undefined)
      throw new GitFetchError(`.gitmodules sets ${key} twice in one section`);
    current[key] = value;
  }
  return out;
}

/**
 * The repository a submodule url names, relative to `baseUrl` (the repository that holds it).
 * Only `https://github.com/<owner>/<name>` (with or without `.git`) is accepted, or a `./` or
 * `../` url that resolves to one.
 */
export function repoOfUrl(raw: string, baseUrl: string): { owner: string; repo: string } {
  if (raw === "") throw new GitFetchError("the submodule has no url");
  if (raw.startsWith("-"))
    throw new GitFetchError(`the submodule url ${show(raw)} looks like an option and is refused`);
  if (CONTROL.test(raw) || /\s/.test(raw))
    throw new GitFetchError(`the submodule url ${show(raw)} has a space or control character`);
  let u: URL;
  try {
    u = raw.startsWith("./") || raw.startsWith("../") ? new URL(raw, `${baseUrl}/`) : new URL(raw);
  } catch {
    throw new GitFetchError(
      `the submodule url ${show(raw)} is not an https url (ssh and scp-style urls are not fetched)`,
    );
  }
  if (u.protocol !== "https:")
    throw new GitFetchError(
      `the submodule url ${show(raw)} is not an https url (only https submodules are fetched)`,
    );
  if (u.username !== "" || u.password !== "")
    throw new GitFetchError("the submodule url carries a credential and is refused");
  if (u.hostname.toLowerCase() !== "github.com" || u.port !== "")
    throw new GitFetchError(
      `the submodule url ${show(raw)} is not on github.com (only github.com, on its default port, is fetched)`,
    );
  if (u.search !== "" || u.hash !== "")
    throw new GitFetchError(`the submodule url ${show(raw)} has a query or fragment`);
  const parts = u.pathname.replace(/\/+$/, "").split("/").slice(1);
  const repo = parts[1]?.replace(/\.git$/, "");
  if (parts.length !== 2 || !isPart(parts[0] as string) || repo === undefined || !isPart(repo))
    throw new GitFetchError(`the submodule url ${show(raw)} is not https://github.com/owner/name`);
  return { owner: parts[0] as string, repo };
}

/**
 * Pairs every gitlink with its `.gitmodules` entry and the repository it names. A gitlink with no
 * entry, a hostile name, path or url, module directories that overlap, or more modules than
 * `maxSubmodules` refuses the whole delivery.
 */
export function resolveSubmodules(o: {
  gitmodules: string | undefined;
  gitlinks: readonly Gitlink[];
  baseUrl: string;
  maxSubmodules: number;
}): SubmoduleSpec[] {
  if (o.gitlinks.length === 0) return [];
  if (o.gitlinks.length > o.maxSubmodules)
    throw new GitFetchError(`the repository has more than ${o.maxSubmodules} submodules`);
  const sections = parseGitmodules(o.gitmodules ?? "");
  // Every entry is checked, not only those a gitlink matches: a hostile file is refused whole.
  for (const [name, s] of sections) {
    if (!validModuleName(name))
      throw new GitFetchError(`the submodule name ${show(name)} is not allowed`);
    if (s.path !== undefined && !validModulePath(s.path))
      throw new GitFetchError(`the submodule path ${show(s.path)} is not allowed`);
  }
  const specs: SubmoduleSpec[] = [];
  for (const link of o.gitlinks.toSorted((a, b) => (a.path < b.path ? -1 : 1))) {
    const matches = [...sections].filter(([, s]) => s.path === link.path);
    if (matches.length !== 1)
      throw new GitFetchError(
        matches.length === 0
          ? `the submodule at ${show(link.path)} has no entry (with that path) in .gitmodules`
          : `the submodule at ${show(link.path)} has more than one entry in .gitmodules`,
      );
    const [name, section] = matches[0] as [string, Section];
    let target: { owner: string; repo: string };
    try {
      target = repoOfUrl(section.url ?? "", o.baseUrl);
    } catch (e) {
      throw new GitFetchError(`submodule ${show(link.path)}: ${(e as Error).message}`);
    }
    specs.push({ name, path: link.path, sha: link.sha, ...target });
  }
  const dirs = specs.map((s) => foldKey(s.name));
  for (const [i, a] of dirs.entries())
    for (const [j, b] of dirs.entries())
      if (i !== j && (a === b || b.startsWith(`${a}/`)))
        throw new GitFetchError("two submodule names overlap in .git/modules");
  return specs;
}

const MANIFEST_MAX = 1024 * 1024;

/** The child's answer to "which modules does this tree name": a small JSON file. */
export function writeManifest(path: string, specs: readonly SubmoduleSpec[]): void {
  writeFileSync(path, JSON.stringify({ modules: specs }), { flag: "wx", mode: 0o600 });
}

/**
 * Reads a manifest a child wrote, trusting nothing: a regular file the same user owns, of bounded
 * size, whose every field is checked again here (the values go into arguments and paths).
 */
export function readManifest(
  path: string,
  o: { maxSubmodules: number; uid?: number | undefined },
): SubmoduleSpec[] {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const st = fstatSync(fd);
    const uid = o.uid ?? process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid) || st.size > MANIFEST_MAX)
      throw new GitFetchError("the checkout's submodule list is not a plain file of a sane size");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    text = buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GitFetchError("the checkout's submodule list is not JSON");
  }
  const list = (raw as { modules?: unknown } | null)?.modules;
  if (!Array.isArray(list) || list.length > o.maxSubmodules)
    throw new GitFetchError(`the repository has more than ${o.maxSubmodules} submodules`);
  return list.map((m): SubmoduleSpec => {
    const e = m as Record<string, unknown>;
    const { name, path, sha, owner, repo } = e;
    if (
      typeof name !== "string" ||
      !validModuleName(name) ||
      typeof path !== "string" ||
      !validModulePath(path) ||
      typeof sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(sha) ||
      typeof owner !== "string" ||
      !isPart(owner) ||
      typeof repo !== "string" ||
      !isPart(repo)
    )
      throw new GitFetchError("the checkout's submodule list has an entry that is not valid");
    return { name, path, sha, owner, repo };
  });
}

/** `<root>/.git/modules/<a>/modules/<b>...` for a chain of module names (parent first). */
export function moduleGitDir(root: string, chain: readonly string[]): string {
  const parts: string[] = [root, ".git"];
  for (const name of chain) {
    if (!validModuleName(name)) throw new GitFetchError("a submodule name is not allowed");
    parts.push("modules", ...name.split("/"));
  }
  return parts.join("/");
}
