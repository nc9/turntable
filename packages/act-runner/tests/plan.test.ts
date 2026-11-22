import { describe, expect, test } from "bun:test";
import { checkoutStubAction } from "../src/checkout-stub";
import { PlanError, planJob, resolveActions, untrustedIn } from "../src/plan";

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
    const r = await resolveActions(p, async (repo, ref) => `${repo.length}${ref}`.padEnd(40, "b"));
    expect(r.actions[1]?.sha).toBe("9v1".padEnd(40, "b"));
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

  test("untrustedIn covers the usual injection sources", () => {
    for (const e of [
      "github.event.issue.body",
      "github.event.comment.body",
      "github.event.pull_request.head.ref",
      "github.event.head_commit.message",
      "github.event.commits[0].message",
    ]) {
      expect(untrustedIn("s", `echo \${{ ${e} }}`).length).toBe(e.includes("[") ? 0 : 1);
    }
    expect(untrustedIn("s", "echo ${{ github.sha }} ${{ secrets.X }}")).toEqual([]);
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
