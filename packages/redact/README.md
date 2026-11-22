# @turntable/redact

Streaming secret redaction for job logs. Runs before anything is stored or shown.

```ts
import { Redactor, SecretRegistry } from "@turntable/redact";

const registry = new SecretRegistry(); // one per job
registry.register(jobSecretValue); // also covers base64 and URL-encoded forms

const redactor = new Redactor({ registry });
const safe = redactor.push(chunk); // string or Uint8Array; returns redacted text
const rest = redactor.end(); // flush once at end of stream
```

`redactString(text, registry?)` redacts a complete string.

## What it redacts

- PEM private key blocks (`BEGIN ... PRIVATE KEY` through `END`)
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) and npm tokens (`npm_`)
- AWS access key ids (`AKIA`, `ASIA`) and the value after `aws_secret_access_key`
- Slack tokens (`xox[abprs]-`)
- JWTs (three base64url segments, the first two starting `eyJ`)
- Bearer tokens in `Authorization` headers (the `Bearer` prefix stays)
- Passwords in URL userinfo (`scheme://user:pass@host`; the user and host stay)
- Registered exact values, plus their base64 (padded and unpadded), base64url and URL-encoded
  forms, and the base64 core of the value as embedded at each of the 3 byte alignments inside a
  larger base64 blob

Registering a value shorter than 8 characters is refused with a warning, since it would
redact ordinary words. The warning never contains the value.

## How the streaming works

Unemitted text sits in a carry buffer. Each `push` scans it, then emits everything up to the
last newline and holds only the current incomplete line, capped at `window - 1` characters,
where `window` is the longest possible match (the built-in patterns top out near 5.6 KiB;
registered values can raise it). A match that straddles the boundary pulls the boundary back
to its start. The carry stays raw and is rescanned with the next chunk, so a secret split at
any offset is found, and none is emitted partially. Only the aws-secret and bearer
patterns can span a newline (a value on the next line); every other pattern is single-line, so
complete lines go out at once. A registered value that contains a newline switches
emission back to the plain window rule.

A key line (`aws_secret_access_key:` or `Authorization: Bearer` at the end of a line) is held
until the next line arrives, so a YAML-style value on the following line is still redacted.

Latency: `flushIdle()` emits the held partial line, redacted. Call it after about a second
without input so the last line of a slow or hung job becomes visible.

Trade-offs:

- **Output length is not preserved.** Every secret becomes `***`, whatever its length.
- **The incomplete last line is held** until a newline, `flushIdle()` or `end()`. Call `end()`
  when the stream closes.
- **`flushIdle()` keeps back what could still be completed:** a partial PEM BEGIN marker, a
  partial or complete key line, a partial key name, and the tail of any registered value that
  is a prefix of one. Those wait for more input (a trailing `-` or a line ending `Authorization`
  stays held until the next chunk or `end()`).
- **`flushIdle()` can leak a token prefix.** A token split across the idle gap has its first
  part already emitted, and that part alone matches no pattern. Use a gap long enough that
  mid-token pauses are rare.
- **Cost is O(held line) per push**, at most the window. Chunks of a few KiB are fine.
- **Unterminated PEM blocks** are held until their `END` marker, up to 256 KiB, then swallowed
  (one `***`) until the marker or `end()`.
- **Over-long tokens** (past a pattern's upper bound, for example 255 characters after `ghp_`)
  are redacted only up to the bound; the remainder is emitted as is.
- **Base64 image data and git SHAs** are untouched: no built-in pattern matches bare hex or
  bare base64. A secret embedded in another base64 blob is found only if registered (the three
  alignments above); an unregistered one is not.
- **Bearer tokens** are matched only inside an `Authorization` header, so prose such as
  "Bearer authentication" is left alone. A bearer token elsewhere is caught only if it is a
  JWT, a known token type or a registered value.

## ReDoS safety

All patterns use bounded character classes and no nested quantifiers, so matching is linear.
`tests/redact.test.ts` feeds adversarial inputs under a time budget.

## Tests

```sh
bun test packages/redact/tests/redact.test.ts
cd packages/redact && bunx tsgo --noEmit -p tsconfig.json
```
