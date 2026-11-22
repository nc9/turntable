/**
 * Built-in secret patterns. Every pattern is linear-time by construction: character classes
 * with explicit upper bounds, no nested or overlapping quantifiers, no backreferences. The
 * upper bounds also give each pattern a maximum match length, which sizes the streaming
 * carry-over window. A token longer than its bound is still redacted in full: see `run`.
 *
 * Only the key/value patterns (aws secret, bearer) may span a newline, so a YAML-style value on
 * the line after its key is still found; the redactor holds a trailing key line for that (see
 * KEY_LINE_END). Every other pattern is single-line (PEM blocks are handled separately), which
 * is what lets the redactor emit complete lines immediately.
 *
 * With `keepPrefix`, capture group 1 (a key name or header prefix) stays in the output and the
 * rest of the match is replaced. The prefix still counts as part of the match when the redactor
 * decides where it may cut the stream.
 */
export type Pattern = {
  name: string;
  re: RegExp;
  /** Upper bound on match length, in UTF-16 code units. */
  maxLength: number;
  /** Keep capture group 1 (prefix) in the output. */
  keepPrefix?: boolean;
  /** Literal that must appear in the text for the pattern to run; a cheap pre-filter. */
  needs?: string;
  /**
   * Character-class body of the token's tail. When the character right after a match is in
   * `trigger` (default `run`), the match hit its upper bound, so the redaction is extended
   * through the following run of `run` characters. Exceeding a bound never means "not redacted".
   */
  run?: string;
  trigger?: string;
};

export const REPLACEMENT = "***";

/** PEM private keys are handled by a state machine in the redactor (unbounded length). */
export const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
export const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
export const PEM_END_MAX = 80;

export const PATTERNS: readonly Pattern[] = [
  {
    name: "github-token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}/g,
    maxLength: 4 + 255 + 1,
    run: "A-Za-z0-9",
  },
  {
    name: "github-fine-grained-pat",
    re: /\bgithub_pat_[A-Za-z0-9_]{22,255}/g,
    maxLength: 11 + 255 + 1,
    run: "A-Za-z0-9_",
  },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36,255}/g, maxLength: 4 + 255 + 1, run: "A-Za-z0-9" },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, maxLength: 21 },
  {
    name: "aws-secret-access-key",
    re: /(aws_secret_access_key["']?\s{0,64}[:=]\s{0,64}["']?)[A-Za-z0-9/+=]{40}/gi,
    maxLength: 21 + 1 + 64 + 1 + 64 + 1 + 40,
    keepPrefix: true,
    run: "A-Za-z0-9/+=",
  },
  {
    name: "slack-token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,250}/g,
    maxLength: 5 + 250 + 1,
    run: "A-Za-z0-9-",
  },
  {
    // A segment over its bound is never "not redacted": past the payload or signature bound the
    // run continues (dots included); an over-long header is caught by the pattern below.
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{5,1024}\.eyJ[A-Za-z0-9_-]{5,4096}(?:\.[A-Za-z0-9_-]{0,4096})?/g,
    maxLength: 3 + 1024 + 1 + 3 + 4096 + 1 + 4096 + 1,
    trigger: "A-Za-z0-9_-",
    run: "A-Za-z0-9_.-",
  },
  {
    name: "jwt-long-header",
    re: /\beyJ[A-Za-z0-9_-]{1024}/g,
    maxLength: 3 + 1024 + 1,
    run: "A-Za-z0-9_.-",
  },
  {
    // Only inside an Authorization header, so prose like "Bearer authentication" is untouched.
    name: "bearer-token",
    re: /(Authorization["']?\s{0,16}[:=]\s{0,16}["']?Bearer\s{1,64})[A-Za-z0-9._~+/=-]{8,4096}/gi,
    maxLength: 13 + 1 + 16 + 1 + 16 + 1 + 6 + 64 + 4096,
    keepPrefix: true,
    run: "A-Za-z0-9._~+/=-",
  },
  {
    // The whole userinfo between `://` and the last `@` of the token is redacted: the username
    // may be empty, the password may hold `/`. A first segment that is a port (`host:8080/`) is
    // not userinfo.
    name: "url-userinfo",
    re: /([a-z][a-z0-9+.-]{1,31}:\/\/)[^\s:@/?#]{0,256}:(?!\d{1,5}(?:\/|$))[^\s]{1,256}(?=@)/gi,
    maxLength: 32 + 3 + 256 + 1 + 256 + 1,
    keepPrefix: true,
    needs: "@",
  },
  {
    // A password past the bound above: redact it and the rest of the token, never skip it.
    name: "url-userinfo-long",
    re: /([a-z][a-z0-9+.-]{1,31}:\/\/)[^\s:@/?#]{0,256}:(?!\d{1,5}(?:\/|$))[^\s]{256}/gi,
    maxLength: 32 + 3 + 256 + 1 + 256,
    keepPrefix: true,
    needs: "://",
    run: "\\S",
  },
];

/** Largest pattern match, used to size the carry-over window. */
export const MAX_PATTERN_LENGTH: number = Math.max(
  ...PATTERNS.map((p) => p.maxLength),
  PEM_END_MAX,
);

/**
 * End of a line that names a key whose value may follow on the next line. Test it against the
 * last 160 characters of one line, never the whole line.
 */
export const KEY_LINE_END =
  /(?:aws_secret_access_key["']?[^\S\n]{0,16}[:=]?[^\S\n]{0,16}["']?|Authorization["']?[^\S\n]{0,16}[:=]?[^\S\n]{0,16}["']?(?:B(?:e(?:a(?:r(?:e(?:r[^\S\n]{0,16})?)?)?)?)?)?)$/i;

/** Key names whose partial spelling at the end of the text must survive an idle flush. */
export const KEY_NAMES: readonly string[] = ["aws_secret_access_key", "authorization"];

export type CompiledPattern = Pattern & { runRe?: RegExp; triggerRe?: RegExp };

/** Patterns with their run-extension regexes built once. */
export const COMPILED: readonly CompiledPattern[] = PATTERNS.map((p) =>
  p.run === undefined
    ? p
    : {
        ...p,
        runRe: new RegExp(`[${p.run}]+`, "y"),
        triggerRe: new RegExp(`[${p.trigger ?? p.run}]`),
      },
);
