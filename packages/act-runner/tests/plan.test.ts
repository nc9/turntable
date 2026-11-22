import { describe, expect, test } from "bun:test";
import { checkoutStubAction } from "../src/checkout-stub";
import {
  PlanError,
  assertNoDockerAccess,
  assertPinned,
  planJob,
  resolveActions,
  rewriteUses,
  staticResolver,
  untrustedIn,
} from "../src/plan";

const CO = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const wf = (job: string): string => `name: t\non: push\njobs:\n  j:\n${job}`;
const plan = (job: string) => planJob(wf(job), "j", { workflowPath: ".github/workflows/ci.yml" });
const feature = (job: string): string | undefined => {
  try {
    plan(job);
  } catch (e) {
    if (e instanceof PlanError) return e.feature;
    throw e;
  }
  return undefined;
};

describe("planJob accepts", () => {
  test("simple job: argv has -W, --concurrent-jobs, host mode, never -n", () => {
    const p = plan(
      `    runs-on: ubuntu-latest\n    steps:\n      - uses: ${CO}\n      - run: echo hi\n`,
    );
    expect(p.argv[0]).toBe("/tmp/tt-act/act");
    expect(p.argv).toContain("-W");
    expect(p.argv[p.argv.indexOf("-W") + 1]).toBe(".github/workflows/ci.yml");
    expect(p.argv[p.argv.indexOf("-j") + 1]).toBe("j");
    expect(p.argv).toContain("--concurrent-jobs");
    expect(p.argv).toContain("--json");
    expect(p.argv).toContain("--no-skip-checkout");
    expect(p.argv[p.argv.indexOf("--artifact-server-addr") + 1]).toBe("127.0.0.1");
    expect(p.argv[p.argv.indexOf("--cache-server-addr") + 1]).toBe("127.0.0.1");
    expect(p.argv).toContain("ubuntu-latest=-self-hosted");
    for (const bad of ["-n", "--dryrun"]) expect(p.argv).not.toContain(bad);
    expect(p.checkoutRefs).toEqual([CO]);
    expect(p.argv).toContain(`${CO}=/tmp/tt-act/stubs/checkout-0`);
    expect(p.cwd).toBe("/tmp/tt-act/repo");
  });
  test("one --local-repository per distinct checkout ref", () => {
    const p = plan(
      `    runs-on: [self-hosted, linux]\n    steps:\n      - uses: ${CO}\n      - uses: ${CO}\n      - uses: actions/checkout@v4\n        with: { path: x }\n`,
    );
    expect(p.argv.filter((a) => a === "--local-repository")).toHaveLength(2);
  });
  test("empty needs is fine", () => {
    expect(feature("    runs-on: ubuntu-24.04\n    needs: []\n    steps: []\n")).toBeUndefined();
  });
});

describe("planJob rejects, naming the feature", () => {
  const base = "    runs-on: ubuntu-latest\n";
  test.each([
    ["needs", `${base}    needs: other\n    steps: []\n`],
    ["services", `${base}    services:\n      db:\n        image: postgres\n    steps: []\n`],
    ["container", `${base}    container: node:22\n    steps: []\n`],
    ["matrix", `${base}    strategy:\n      matrix:\n        n: [1, 2]\n    steps: []\n`],
    ["non-Linux runs-on", "    runs-on: windows-latest\n    steps: []\n"],
    ["non-Linux runs-on", "    runs-on: macos-14\n    steps: []\n"],
    ["runs-on expression", "    runs-on: ${{ matrix.os }}\n    steps: []\n"],
    ["docker:// action", `${base}    steps:\n      - uses: docker://alpine:3\n`],
    ["reusable workflow", "    uses: ./.github/workflows/x.yml\n"],
  ])("%s", (name, job) => {
    expect(feature(job)).toBe(name);
  });
  test("unknown job and bad yaml", () => {
    expect(() =>
      planJob(wf("    runs-on: ubuntu-latest\n    steps: []\n"), "nope", { workflowPath: "w" }),
    ).toThrow(PlanError);
    expect(() => planJob("a: [", "j", { workflowPath: "w" })).toThrow(PlanError);
  });
});

const SHA = "a".repeat(40);

describe("security requirements", () => {
  test("never mounts the container socket", () => {
    const p = plan("    runs-on: ubuntu-latest\n    steps: []\n");
    const i = p.argv.indexOf("--container-daemon-socket");
    expect(p.argv[i + 1]).toBe("-");
    for (const bad of ["-b", "--bind"]) expect(p.argv).not.toContain(bad);
    expect(p.argv.join(" ")).not.toContain("docker.sock");
  });

  test("records the action list with shas; tags stay unresolved until resolveActions", async () => {
    const p = plan(
      `    runs-on: ubuntu-latest\n    steps:\n      - uses: ${CO}\n      - uses: acme/tool/sub@v1\n      - uses: acme/pinned@${SHA}\n      - uses: ./local\n`,
    );
    expect(p.actions.map((a) => [a.repo, a.subpath, a.ref, a.sha, a.kind])).toEqual([
      ["actions/checkout", "", CO.split("@")[1], CO.split("@")[1], "checkout"],
      ["acme/tool", "sub", "v1", undefined, "remote"],
      ["acme/pinned", "", SHA, SHA, "remote"],
    ]);
    expect(p.argv).toContain("acme/tool@v1=/tmp/tt-act/stubs/action-1");
    const r = await resolveActions(p, staticResolver({ "acme/tool@v1": "d".repeat(40) }));
    expect(r.actions[1]?.sha).toBe("d".repeat(40));
    expect(r.argv).toContain(`acme/tool@${"d".repeat(40)}=/tmp/tt-act/stubs/action-1`);
    expect(r.actions[2]?.sha).toBe(SHA);
    expect(p.actions[1]?.sha).toBeUndefined();
  });

  test("warns on untrusted context interpolated into run and script", () => {
    const p = plan(
      `    runs-on: ubuntu-latest\n    steps:\n      - name: bad\n        run: echo "\${{ github.event.pull_request.title }}"\n      - name: ok\n        env:\n          T: \${{ github.event.pull_request.title }}\n        run: echo "$T \${{ github.sha }}"\n      - uses: acme/gs@${SHA}\n        with:\n          script: console.log('\${{ github.head_ref }}')\n`,
    );
    expect(p.warnings.map((w) => [w.code, w.step, w.expression])).toEqual([
      ["untrusted-expression", "bad", "github.event.pull_request.title"],
      ["untrusted-expression", "step 3", "github.head_ref"],
    ]);
  });

  test.each([
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.pull_request.head.ref",
    "github.event.pull_request.head.label",
    "github.event.issue.title",
    "github.event.issue.body",
    "github.event.comment.body",
    "github.event.review.body",
    "github.head_ref",
    "github.event.commits.*.message",
    "github.event.commits[0].message",
    "github.event.commits[1].author.name",
    "github.event.head_commit.message",
  ])("untrusted: %s", (e) => {
    expect(untrustedIn("s", `echo "\${{ ${e} }}"`)).toHaveLength(1);
  });

  test("trusted expressions do not warn", () => {
    expect(
      untrustedIn("s", "echo ${{ github.sha }} ${{ secrets.X }} ${{ steps.a.outputs.b }}"),
    ).toEqual([]);
  });

  test("a job's argv and a checked command never expose docker", () => {
    expect(() => assertNoDockerAccess(["act", "-v", "/var/run/docker.sock:/x"])).toThrow(PlanError);
    expect(() => assertNoDockerAccess(["act", "--privileged"])).toThrow(PlanError);
    expect(() => assertNoDockerAccess(["act", "--container-daemon-socket", "/var/run/x"])).toThrow(
      PlanError,
    );
    expect(() => assertNoDockerAccess(["act", "-b"])).toThrow(PlanError);
    const p = plan("    runs-on: ubuntu-latest\n    steps: []\n");
    expect(() => assertNoDockerAccess(p.argv)).not.toThrow();
  });

  test("rewriteUses pins tags to shas, keeps comments, passes shas through", () => {
    const sha = "e".repeat(40);
    const text = `steps:\n  - uses: acme/tool/sub@v1 # keep\n  - uses: "acme/other@main"\n  - uses: acme/pinned@${SHA}\n`;
    const p = plan(
      `    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/tool/sub@v1\n      - uses: acme/other@main\n      - uses: acme/pinned@${SHA}\n`,
    );
    const actions = p.actions.map((a) => (a.sha ? a : { ...a, sha }));
    expect(rewriteUses(text, actions)).toBe(
      `steps:\n  - uses: acme/tool/sub@${sha} # keep\n  - uses: "acme/other@${sha}" # main\n  - uses: acme/pinned@${SHA}\n`,
    );
  });

  test("local composite actions are scanned and rewritten too", async () => {
    const files: Record<string, string> = {
      ".github/actions/x/action.yml":
        'name: x\nruns:\n  using: composite\n  steps:\n    - uses: acme/inner@v2\n    - shell: bash\n      run: echo "${{ github.head_ref }}"\n',
    };
    const p = planJob(
      wf("    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/x\n"),
      "j",
      { workflowPath: ".github/workflows/ci.yml", readFile: (f) => files[f] },
    );
    expect(p.actions.map((a) => a.uses)).toEqual(["acme/inner@v2"]);
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]?.file).toBe(".github/actions/x/action.yml");
    const r = await resolveActions(p, staticResolver({ "acme/inner@v2": "f".repeat(40) }));
    const f = r.files.find((x) => x.path.endsWith("action.yml"));
    expect(f?.text).toContain(`acme/inner@${"f".repeat(40)} # v2`);
  });

  test("checkout stub only copies the delivered workspace, never touches the network", () => {
    const s = checkoutStubAction("/tmp/tt-act/repo");
    for (const net of [
      "git fetch",
      "git clone",
      "git pull",
      "curl",
      "wget",
      "http://",
      "https://",
    ]) {
      expect(s).not.toContain(net);
    }
    expect(s).toContain("cp -a '/tmp/tt-act/repo'/.");
  });
});

describe("pinning fails closed whatever the YAML looks like", () => {
  const SHA2 = "d".repeat(40);
  const head = "    runs-on: ubuntu-latest\n    steps:\n";
  const forms: [string, string][] = [
    ["plain list item", "      - uses: acme/tool@v1\n"],
    ["flow mapping", "      - { uses: acme/tool@v1, with: { a: b } }\n"],
    ["quoted key", '      - "uses": acme/tool@v1\n'],
    ["quoted value", "      - uses: 'acme/tool@v1'\n"],
    ["block scalar", "      - uses: >-\n          acme/tool@v1\n"],
    ["name on same line", "      - name: x\n        uses: acme/tool@v1\n"],
    ["anchor and alias", "      - &s\n        uses: acme/tool@v1\n      - *s\n"],
    ["merge key", "      - <<: { uses: acme/tool@v1 }\n"],
  ];
  test.each(forms)("%s is delivered locally by sha (never fetched)", async (_n, steps) => {
    const p = plan(head + steps);
    const r = await resolveActions(p, staticResolver({ "acme/tool@v1": SHA2 }));
    // Both the written ref and the sha point at the same sha-delivered dir.
    const keys = r.argv.filter((_a, i) => r.argv[i - 1] === "--local-repository");
    expect(keys).toContain("acme/tool@v1=/tmp/tt-act/stubs/action-0");
    expect(keys).toContain(`acme/tool@${SHA2}=/tmp/tt-act/stubs/action-0`);
    expect(() => assertPinned(r)).not.toThrow();
  });

  const stripMappings = (argv: string[]): string[] =>
    argv.filter((a, i) => a !== "--local-repository" && argv[i - 1] !== "--local-repository");

  test.each([
    ["a tag", "acme/tool@v1"],
    ["a sha", `acme/tool@${SHA}`],
  ])("%s with no local mapping throws unpinned-action", async (_n, uses) => {
    const p = plan(head + `      - { uses: ${uses} }\n`);
    const r = await resolveActions(p, staticResolver({ "acme/tool@v1": SHA2 }));
    expect(() => assertPinned(r)).not.toThrow();
    try {
      assertPinned({ ...r, argv: stripMappings(r.argv) });
      throw new Error("expected PlanError");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError);
      expect((e as PlanError).feature).toBe("unpinned-action");
    }
  });
});
