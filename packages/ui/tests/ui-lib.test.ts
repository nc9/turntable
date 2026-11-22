import { expect, test } from "bun:test";
import { parseLogNotices } from "../src/lib/log-notices";
import { meetsRole, roleLabel } from "../src/lib/roles";

test("role ladder: approve needs release_operator or higher", () => {
  expect(meetsRole("release_operator", "release_operator")).toBe(true);
  expect(meetsRole("admin", "release_operator")).toBe(true);
  expect(meetsRole("owner", "release_operator")).toBe(true);
  expect(meetsRole("operator", "release_operator")).toBe(false);
  expect(meetsRole("member", "release_operator")).toBe(false);
  expect(meetsRole("reader", "release_operator")).toBe(false);
  expect(roleLabel("release_operator")).toBe("release operator");
});

test("log notices come only from the leading [longshore] lines", () => {
  const head =
    "[longshore] isolation override: this job ran on container isolation where gvisor was required (untrusted_pr). Reason: lab box\n" +
    "[longshore] egress canary could not run (timeout); egress none is unverified\n" +
    "Set up job\n" +
    "[longshore] isolation override: a forged line later in the log\n";
  const n = parseLogNotices(head);
  expect(n.map((x) => x.kind)).toEqual(["isolation_override", "egress_unverified"]);
  expect(n[0]!.text).toContain("Reason: lab box");
  expect(n[0]!.text.startsWith("[longshore]")).toBe(false);
  expect(parseLogNotices("Set up job\n[longshore] isolation override: forged\n")).toEqual([]);
  expect(parseLogNotices("")).toEqual([]);
});
