// A live round trip against a real 1Password test vault, through the real SDK. Run on purpose:
//   TT_OP_TOKEN_FILE=/path/to/token TT_OP_REF='op://<vault>/<item>/<field>' bun run test:onepassword-live
// It skips unless TT_OP_TOKEN_FILE names a file holding a read-only service-account token for a
// test vault, and TT_OP_REF names a field in it. Never in default CI. No value is ever printed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OnePasswordBackend, parseOpRef } from "../src/secrets/backends/onepassword";
import { BackendError } from "../src/secrets/backends/types";
import { account, config } from "./op-fake";

const tokenFile = process.env.TT_OP_TOKEN_FILE;
const reference = process.env.TT_OP_REF;
const live = Boolean(tokenFile && reference);

describe.skipIf(!live)("1Password, live", () => {
  const ref = parseOpRef(reference ?? "op://v/i/f");
  const backend = () =>
    new OnePasswordBackend({
      config: config(
        [
          account({
            name: "live",
            token: readFileSync(tokenFile!, "utf8").trim(),
            vaults: [ref.vault],
          }),
        ],
        {
          canary: reference,
        },
      ),
    });

  test("resolves the reference to a non-empty value, then serves it from the cache", async () => {
    const b = backend();
    const first = await b.resolve("live", ref);
    expect(first.length).toBeGreaterThan(0);
    expect(await b.resolve("live", ref)).toBe(first);
  }, 60_000);

  test("an unknown field fails closed as not_found", async () => {
    const err = await backend()
      .resolve("live", { ...ref, field: `no-such-field-${Date.now()}` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).kind).toBe("not_found");
  }, 60_000);

  test("the doctor canary reports reachable", async () => {
    const h = await backend().health();
    expect(h.canary).toMatchObject({ configured: true, reachable: true });
  }, 60_000);
});
