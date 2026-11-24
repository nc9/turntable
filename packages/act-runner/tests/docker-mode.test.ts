// act's container mode for a job routed to the docker class (#497): the plan's argv, the shims
// that are not installed, and the sandbox preflight (docker info, images with egress none).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { drain, planJob, runJob, sha256Hex, tarDirectory } from "../src/index";
import { launcherArgv } from "../src/step-env";

const world = new FakeWorld({ exec: { tickSeconds: 1 } });
const tmp = mkdtempSync(join(tmpdir(), "tt-docker-mode-"));
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

const WF = `name: t
on: push
jobs:
  hello:
    runs-on: ubuntu-latest
    container: node:22
    services:
      db:
        image: postgres:16
      cache:
        image: \${{ vars.CACHE_IMAGE }}
    steps:
      - run: echo hi
`;
const IMG = "runner/base:1";
const mk = (docker: boolean, root = "/tmp/tt-act") =>
  planJob(WF, "hello", {
    workflowPath: ".github/workflows/ci.yml",
    readFile: () => undefined,
    root,
    ...(docker ? { docker: { image: IMG } } : {}),
  });

describe("the plan", () => {
  test("container mode maps every label to the image; no host-mode label; the socket is still not passed", () => {
    const p = mk(true);
    expect(p.argv).toContain(`ubuntu-latest=${IMG}`);
    expect(p.argv).toContain(`self-hosted=${IMG}`);
    expect(p.argv.join(" ")).not.toContain("-self-hosted");
    expect(p.argv[p.argv.indexOf("--container-daemon-socket") + 1]).toBe("-");
    expect(p.docker).toEqual({ image: IMG, images: [IMG, "node:22", "postgres:16"] });
  });

  test("without docker, services and container are still refused by planJob", () => {
    expect(() => mk(false)).toThrow(/services|container/);
  });

  test("the launcher skips the shim PATH in container mode", () => {
    expect(launcherArgv("/s", ["act"], "", false)[2]).not.toContain("PATH");
    expect(launcherArgv("/s", ["act"])[2]).toContain('PATH="$1:$PATH"');
  });
});

/** A `docker` in the double's PATH whose behaviour is fixed per sandbox world. */
function withDocker(info: boolean, haveImages: boolean): { w: FakeWorld } {
  const w = new FakeWorld({ exec: { tickSeconds: 1 } });
  const bin = join(w.root, "bin", "docker");
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  info) ${info ? "exit 0" : 'echo "daemon down" >&2; exit 1'} ;;
  image) ${haveImages ? "exit 0" : "exit 1"} ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return { w };
}

async function runIn(w: FakeWorld, egress: "none" | "open", proxy = false) {
  const p = w.provider();
  const { id } = await p.create({
    name: "act",
    labels: { t: "act" },
    ttlSeconds: 300,
    network: { egress: "open" },
  });
  const plan = mk(true, `${w.sandboxDir(id)}/tt`);
  const d = mkdtempSync(join(tmp, "t-"));
  writeFileSync(join(d, "act"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const bytes = await tarDirectory(d, ["act"]);
  const r = mkdtempSync(join(tmp, "r-"));
  writeFileSync(join(r, "README.md"), "hi\n");
  const repoTarball = await tarDirectory(r, ["README.md"]);
  const res = await drain(
    runJob(
      p,
      id,
      plan,
      {
        repoTarball,
        act: { bytes, sha256: sha256Hex(bytes) },
        docker: { egress, waitSeconds: 0 },
        ...(proxy ? { proxy: { url: "http://x", caPem: "pem" } } : {}),
      },
      { pollMs: 20 },
    ),
  );
  return res;
}

describe("the sandbox preflight", () => {
  test("docker info failing is infra_error with the reason; act never starts", async () => {
    const { w } = withDocker(false, true);
    const res = await runIn(w, "open");
    w.dispose();
    expect(res.state).toBe("infra_error");
    expect(res.reason).toContain("no working Docker daemon");
    expect(res.reason).toContain("daemon down");
  });

  test("egress none and a missing image fails naming the first missing image", async () => {
    const { w } = withDocker(true, false);
    const res = await runIn(w, "none");
    w.dispose();
    expect(res.state).toBe("failure");
    expect(res.reason).toContain(`image ${IMG} is not in the sandbox and egress is none`);
  });

  test("egress none with the images present runs act", async () => {
    const { w } = withDocker(true, true);
    const res = await runIn(w, "none");
    w.dispose();
    expect(res.state).not.toBe("failure");
  });

  test("open egress does not check images (act pulls them)", async () => {
    const { w } = withDocker(true, false);
    const res = await runIn(w, "open");
    w.dispose();
    expect(res.reason).not.toContain("is not in the sandbox");
  });

  test("a container-mode job behind the secrets proxy is refused (the proxy settings do not reach its containers)", async () => {
    const { w } = withDocker(true, true);
    const res = await runIn(w, "none", true);
    w.dispose();
    expect(res.state).toBe("infra_error");
    expect(res.reason).toContain("secrets proxy");
  });
});
