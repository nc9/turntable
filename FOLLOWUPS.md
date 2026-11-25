# Follow-ups

- Refuse unsupported signing backends at config time. `policy set --signing-key aws-kms:<key>` and `gcp-kms:<key>` pass `parseKeyRef` (`packages/core/src/signing/service.ts`, `packages/core/src/ops/policy-cli.ts`), and the refusal only happens at signing time as `no_backend`, because the release lane wires the built-in signer only (`packages/core/src/release/serve.ts`). `policy set` should reject a backend with no signer wired. Open a GCP KMS issue as well.
