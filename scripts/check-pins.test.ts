import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkDockerfile,
  checkRepo,
  checkRuntimeDownloads,
  checkToolVersions,
  checkUses,
  checkWorkflowImages,
} from "./check-pins";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const DIGEST = `sha256:${"a".repeat(64)}`;
const wf = (text: string) => ({ path: ".github/workflows/x.yml", text });
const df = (text: string) => ({ path: "Dockerfile", text });
const whats = (f: { what: string }[]) => f.map((x) => x.what);

describe("actions", () => {
  test("a full commit SHA is pinned; a tag, a branch, a short SHA and no ref are not", () => {
    const text = [
      `      - uses: actions/checkout@${SHA} # v7`,
      "      - uses: actions/checkout@v4",
      "      - uses: actions/checkout@main",
      "      - uses: actions/checkout@3d3c42e",
      "      - uses: actions/checkout",
      `      - uses: "actions/cache@${SHA}"`,
      "      - uses: ./local-action",
      `      - uses: docker://alpine@${DIGEST}`,
      "      - uses: docker://alpine:3.22",
    ].join("\n");
    const f = checkUses(wf(text));
    expect(f.map((x) => x.line)).toEqual([2, 3, 4, 5, 9]);
    expect(whats(f)[4]).toContain("docker://");
  });

  test("a commented-out uses and prose are not findings", () => {
    expect(checkUses(wf("# uses: actions/checkout@v4\n      run: echo uses: x@y"))).toEqual([]);
  });

  test("a job-level reusable workflow is checked too", () => {
    expect(checkUses(wf("    uses: org/repo/.github/workflows/a.yml@main")).length).toBe(1);
  });
});

describe("images in workflows", () => {
  test("an image tag is refused, a digest is not, and a pin-ok line is excused", () => {
    const text = [
      "      image: alpine:3.22",
      `      image: alpine:3.22@${DIGEST}`,
      "          TT_ACT_IMAGE: node:22-bookworm",
      `          TT_DOCKER_IMAGE: alpine:3.22@${DIGEST}`,
      "      image: ghcr.io/x/y@${{ steps.push.outputs.digest }}",
      "        run: docker run --rm alpine:3.22 true",
      `        run: docker run --rm alpine:3.22@${DIGEST} true`,
      "        run: docker run --rm --network none built:ci true # pin-ok: built above",
      "        run: docker pull ubuntu",
    ].join("\n");
    expect(checkWorkflowImages(wf(text)).map((x) => x.line)).toEqual([1, 3, 6, 9]);
  });
});

describe("Dockerfiles", () => {
  test("base images need a digest; stages and scratch and an ARG default are followed", () => {
    const text = [
      `ARG BASE=node:22@${DIGEST}`,
      "FROM ${BASE}",
      "FROM debian:12 AS build",
      "FROM build",
      "FROM scratch",
      `FROM gcr.io/distroless/cc@${DIGEST}`,
      "FROM node:22",
    ].join("\n");
    const f = checkDockerfile(df(text));
    expect(f.map((x) => x.line)).toEqual([3, 7]);
  });

  test("an ARG default without a digest is caught through the FROM that uses it", () => {
    expect(checkDockerfile(df("ARG BASE=node:22\nFROM ${BASE}")).length).toBe(1);
  });

  test("a download needs a checksum in the same RUN, continuation lines included", () => {
    const ok = [
      "RUN set -eux; \\",
      "    curl -fsSL -o /tmp/x https://example.com/x; \\",
      '    echo "abc  /tmp/x" | sha256sum -c -',
    ].join("\n");
    expect(checkDockerfile(df(`FROM scratch\n${ok}`))).toEqual([]);
    const bad = ["FROM scratch", "RUN apt-get update", "RUN curl -fsSL https://x.sh | sh"].join(
      "\n",
    );
    const f = checkDockerfile(df(bad));
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(3);
    const wget = checkDockerfile(df("FROM scratch\nRUN wget https://example.com/x -O /x"));
    expect(wget).toHaveLength(1);
  });
});

describe("runtime downloads and toolchains", () => {
  test("every sha256 in a download table must be 64 hex characters, and be used", () => {
    const good = `const T = { a: { sha256: "${"b".repeat(64)}" } }; createHash("sha256")`;
    expect(checkRuntimeDownloads({ path: "a.ts", text: good })).toEqual([]);
    expect(
      checkRuntimeDownloads({ path: "a.ts", text: 'const T = { a: { sha256: "abc" } };' }).length,
    ).toBeGreaterThan(0);
    expect(
      checkRuntimeDownloads({ path: "a.ts", text: `const T = { sha256: "${"b".repeat(64)}" };` }),
    ).toHaveLength(1);
  });

  test("bun-version must be exact", () => {
    const text = [
      "bun-version: 1.4.5",
      "bun-version: latest",
      'bun-version: "1.x"',
      "bun-version: ^1.4.0",
    ].join("\n");
    expect(checkToolVersions(wf(text)).map((x) => x.line)).toEqual([2, 3, 4]);
  });
});

test("this repository pins everything it fetches", () => {
  const found = checkRepo(join(import.meta.dir, ".."));
  expect(found.map((f) => `${f.file}:${f.line} ${f.what}`)).toEqual([]);
});
