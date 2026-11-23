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
- URL userinfo (`scheme://user:pass@host`): everything between `://` and the last `@` of the
  token, so an empty username and a `/` in the password are covered. A first segment that looks
  like a port (`host:8080/x`) is userinfo only when an `@` follows in the same token (so
  `localhost:4873/@scope/pkg` is redacted, a known false positive); an over-long username
  (256+ characters) or password redacts the rest of the token
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
until a non-blank line arrives, so a YAML-style value on a later line is still redacted. Key and
value may be separated by up to 130 whitespace characters in total, blank lines included. The patterns and the hold
are built from the same whitespace constants, and a differential test (streaming split at every
offset equals one-shot, over every whitespace and newline gap) keeps them from drifting.

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
- **Over-long tokens are still redacted in full.** When a token hits a pattern's upper bound and
  the next character still belongs to it, the redaction extends through the rest of the run. In
  a stream the replacement is emitted at once and the continuation is dropped as it arrives
  (bounded memory). A JWT over-long in any segment, a `ghp_` token over 255 characters and a
  URL password over 256 characters are all covered. An over-long URL password takes the rest of
  its whitespace-delimited token with it.
- **A token run never swallows what follows it.** When an over-long token's run would absorb a
  PEM BEGIN marker or a key name (`aws_secret_access_key`, `Authorization`), it stops there and
  the context is scanned on its own, one shot or streamed. A tail that could still grow into
  such a start is kept raw until the next chunk.
- **The stream is never cut inside a match, prefix included.** A cut that would fall between
  `Authorization: Bearer ` and its value steps back to the start of the prefix.
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
cd packages/redact && bun check
```
