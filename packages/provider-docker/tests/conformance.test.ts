import { test } from "bun:test";
import { runConformance } from "@turntable/provider-conformance";
import { DockerProvider } from "../src/index";

// Runs in CI only (TT_DOCKER_CONFORMANCE=1). It needs a Docker daemon and pulls an image.
if (process.env.TT_DOCKER_CONFORMANCE === "1") {
  runConformance(() => new DockerProvider(), {
    name: "docker",
    spec: { image: process.env.TT_DOCKER_IMAGE ?? "alpine:3.22" },
  });
} else {
  test.skip("docker conformance (set TT_DOCKER_CONFORMANCE=1)", () => {});
}
