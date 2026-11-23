import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeDist, BINARIES, checkImageSbom, checkSbom, checkSums } from "./release-checks";
import { checkAgainstSums, compareHashes, parseSums } from "./repro-check";
import { buildSbom } from "./sbom";
import { bunMentions, collect, disagreements } from "./toolchain-versions";

const root = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "ls-release-checks-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function dist(
  over: { omit?: string; extra?: [string, string]; badLine?: string; tamper?: string } = {},
): string {
  const dir = mkdtempSync(join(tmp, "dist-"));
  const files: Record<string, string> = Object.fromEntries(BINARIES.map((b) => [b, `bin ${b}`]));
  files["turntable-0.1.0.cdx.json"] = "{}";
  if (over.extra) files[over.extra[0]] = over.extra[1];
  const lines = Object.entries(files)
    .filter(([n]) => n !== over.omit)
    .map(([n, c]) => `${sha(c)}  ${n}`);
  for (const [n, c] of Object.entries(files)) {
    writeFileSync(join(dir, n), n === over.tamper ? `${c} changed` : c);
  }
  if (over.badLine) lines.push(over.badLine);
  writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return dir;
}

describe("SHA256SUMS", () => {
  test("a complete, true list passes", () => {
    expect(checkSums(dist())).toEqual([]);
  });
  test("a missing binary entry, a changed file, an unlisted file and a malformed line fail", () => {
    expect(checkSums(dist({ omit: "turntable-linux-arm64" })).map((p) => p.what)).toEqual(
      expect.arrayContaining([
        "turntable-linux-arm64 is not in SHA256SUMS",
        "turntable-linux-arm64 is in dist but not in SHA256SUMS",
      ]),
    );
    expect(checkSums(dist({ tamper: "turntable-linux-x64" })).map((p) => p.what)).toContain(
      "turntable-linux-x64 does not match its SHA256SUMS entry",
    );
    expect(
      checkSums(dist({ extra: ["notes.txt", "x"], omit: "notes.txt" })).map((p) => p.what),
    ).toContain("notes.txt is in dist but not in SHA256SUMS");
    expect(checkSums(dist({ badLine: "not a checksum line" })).length).toBeGreaterThan(0);
    expect(checkSums(join(tmp, "no-such-dir"))[0]!.what).toContain("missing");
  });
  test("a second SBOM, or none, is a problem", () => {
    expect(
      checkSums(dist({ extra: ["turntable-0.2.0.cdx.json", "{}"] })).map((p) => p.what),
    ).toContain("expected one SBOM file in dist, found 2");
  });
});

describe("the binary SBOM", () => {
  const lock = readFileSync(join(root, "bun.lock"), "utf8");
  const real = JSON.stringify(buildSbom({ lockText: lock, version: "0.1.0" }));
  test("the SBOM the generator writes passes against the lockfile", () => {
    expect(checkSbom(real, lock)).toEqual([]);
  });
  test("a package dropped, one added, a hash removed, or not JSON fails", () => {
    const bom = JSON.parse(real) as { components: { purl: string; hashes: unknown[] }[] };
    const dropped = { ...bom, components: bom.components.slice(1) };
    expect(checkSbom(JSON.stringify(dropped), lock)[0]!.what).toContain("missing from the SBOM");
    const added = {
      ...bom,
      components: [...bom.components, { purl: "pkg:npm/not-shipped@1.0.0", hashes: [] }],
    };
    expect(checkSbom(JSON.stringify(added), lock).map((p) => p.what)).toContain(
      "in the SBOM but not shipped: pkg:npm/not-shipped@1.0.0",
    );
    const unhashed = {
      ...bom,
      components: bom.components.map((c, i) => (i === 0 ? { ...c, hashes: [] } : c)),
    };
    expect(checkSbom(JSON.stringify(unhashed), lock)[0]!.what).toContain("no hash for");
    expect(checkSbom("nope", lock)).toEqual([{ what: "the SBOM is not JSON" }]);
    expect(checkSbom(JSON.stringify({ ...bom, bomFormat: "SPDX" }), lock)[0]!.what).toContain(
      "CycloneDX",
    );
  });
});

describe("the image SBOM", () => {
  const comps = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p${i}` }));
  test("CycloneDX with the base image's packages passes; empty, tiny or wrong format fails", () => {
    const ok = { bomFormat: "CycloneDX", specVersion: "1.5", components: comps(40) };
    expect(checkImageSbom(JSON.stringify(ok))).toEqual([]);
    expect(checkImageSbom(JSON.stringify({ ...ok, components: comps(2) }))[0]!.what).toContain(
      "did not see",
    );
    expect(checkImageSbom(JSON.stringify({ ...ok, components: [] }))).toHaveLength(1);
    expect(checkImageSbom(JSON.stringify({ ...ok, bomFormat: "x" }))[0]!.what).toContain(
      "CycloneDX",
    );
    expect(checkImageSbom("<html>")).toEqual([{ what: "the image SBOM is not JSON" }]);
  });
});

describe("reproducibility comparison", () => {
  const a = sha("a");
  const b = sha("b");
  test("identical lists are the same; a different or missing binary is not", () => {
    expect(compareHashes({ x: a, y: b }, { x: a, y: b }).every((c) => c.same)).toBe(true);
    expect(compareHashes({ x: a }, { x: b })[0]!.same).toBe(false);
    expect(compareHashes({ x: a }, { x: a, y: b }).find((c) => c.name === "y")!.same).toBe(false);
    expect(compareHashes({}, {})).toEqual([]);
  });
  test("SHA256SUMS lines parse, other lines are ignored", () => {
    expect(parseSums(`${a}  turntable-linux-x64\nnoise\n${b}  turntable-darwin-arm64\n`)).toEqual({
      "turntable-linux-x64": a,
      "turntable-darwin-arm64": b,
    });
  });
});

describe("toolchain versions", () => {
  test("the repository names one bun version everywhere", () => {
    const m = bunMentions(collect(root));
    expect(m.length).toBeGreaterThan(5);
    expect(disagreements(m)).toEqual([]);
  });
  test("a workflow or Dockerfile that names another version is reported, with where", () => {
    const m = bunMentions([
      { name: "a.yml", text: "      bun-version: 1.4.5\n" },
      { name: "b.yml", text: "        bun-version: '1.4.6'  # newer\n" },
      { name: "Dockerfile", text: `FROM oven/bun:1.4.5@sha256:${"0".repeat(64)} AS build\n` },
    ]);
    expect(m.map((x) => x.version)).toEqual(["1.4.5", "1.4.6", "1.4.5"]);
    expect(disagreements(m)).toEqual([
      "a.yml:1 names bun 1.4.5 (found 1.4.5, 1.4.6)",
      "b.yml:1 names bun 1.4.6 (found 1.4.5, 1.4.6)",
      "Dockerfile:1 names bun 1.4.5 (found 1.4.5, 1.4.6)",
    ]);
    expect(disagreements([])[0]).toContain("no bun version found");
  });
});

describe("the output directory guard", () => {
  const repo = join(tmp, "home", "me", "repo");
  const home = join(tmp, "home", "me");
  test("the root, the home directory, the repository and anything above them are refused", () => {
    for (const bad of [
      "/",
      home,
      repo,
      join(tmp, "home"),
      tmp,
      `${repo}/`,
      `${repo}/..`,
      `${home}/.`,
    ]) {
      expect(() => assertSafeDist(bad, repo, home)).toThrow(/refusing TURNTABLE_DIST/);
    }
  });
  test("a directory inside the repository, or elsewhere, is allowed", () => {
    expect(assertSafeDist(join(repo, "dist"), repo, home)).toBe(join(repo, "dist"));
    expect(assertSafeDist(join(tmp, "elsewhere", "out"), repo, home)).toBe(
      join(tmp, "elsewhere", "out"),
    );
    expect(assertSafeDist(join(home, "scratch"), repo, home)).toBe(join(home, "scratch"));
  });
  test("a symlink into the repository is judged by where it points", () => {
    mkdirSync(repo, { recursive: true });
    const link = join(tmp, "link-to-repo");
    symlinkSync(repo, link);
    expect(() => assertSafeDist(link, repo, home)).toThrow(/refusing/);
  });
});

describe("rebuilt binaries against the published list", () => {
  const h = (s: string) => sha(s);
  test("equal linux hashes pass; a different, missing or absent one fails; darwin is ignored", () => {
    const built = { "turntable-linux-x64": h("a"), "turntable-darwin-arm64": h("unsigned") };
    const published = { "turntable-linux-x64": h("a"), "turntable-darwin-arm64": h("signed") };
    expect(checkAgainstSums(built, published)).toEqual([]);
    expect(checkAgainstSums(built, { ...published, "turntable-linux-x64": h("b") })[0]).toContain(
      "differs from the published",
    );
    expect(checkAgainstSums(built, {})[0]).toContain("is not in the published");
    expect(checkAgainstSums({ "turntable-darwin-arm64": h("x") }, published)[0]).toContain(
      "no linux binary",
    );
  });
});
