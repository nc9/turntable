// The entry scripts/op-embed.test.ts compiles: loads the real SDK and asks it to build a client
// with a malformed token. The SDK decodes the token inside its WASM core, so an error that says
// the token is invalid proves the core loaded and ran.
const sdk = await import("@1password/sdk");
try {
  await sdk.createClient({
    auth: "ops_invalid",
    integrationName: "embed-test",
    integrationVersion: "1",
  });
  console.log("unexpected: no error");
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
}
export {};
