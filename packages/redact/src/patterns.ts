/**
 * Built-in secret patterns. Every pattern is linear-time by construction: character classes
 * with explicit upper bounds, no nested or overlapping quantifiers, no backreferences. The
 * upper bounds also give each pattern a maximum match length, which sizes the streaming
 * carry-over window. A token longer than its bound is still redacted in full: see `run`.
 *
 * Only the key/value patterns (aws secret, bearer) may span newlines, within one bounded
 * whitespace gap, so a YAML-style value on a later line is still found; the redactor holds the
 * key line (and any blank lines after it) for that (see KEY_LINE_END). Every other pattern is single-line (PEM blocks are handled separately), which
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

// Whitespace shared by the key/value patterns and KEY_LINE_END, so the two cannot drift: the hold
// in the redactor must cover exactly the gaps the patterns accept.
const WS_MAX = 64;
/** Line-local whitespace: anything but newline, so CR, FF and VT count. */
const WS = `[^\\S\\n]{0,${WS_MAX}}`;
/**
 * Gap between a key and its value: up to GAP_MAX whitespace characters in total, newlines
 * (blank lines) included. The redactor holds a key line while only whitespace follows it, within
 * the same bound.
 */
export const KEY_GAP_MAX = 130;
const GAP_MAX = KEY_GAP_MAX;
const GAP = `\\s{0,${GAP_MAX}}`;
/** Whitespace after a key on its own line: as much as GAP can swallow without the newline. */
const GAP_ON_LINE = `[^\\S\\n]{0,${GAP_MAX}}`;

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
  {
    // Longshore's own tokens (core/src/ops/tokens.ts): a prefix and 32 random bytes as base64url,
    // exactly 43 characters. `lsi_` is the instance administrator's, `ls_` an org's, and `tt_` the
    // same org token minted before the rename (still accepted). No boundary on either side: the
    // 43 characters are distinctive enough that `ls_colors` and other words are safe without one,
    // and a token glued to other text (`xls_<token>`, `<token>abc`, `id=ls_<token>X`) still holds
    // a usable credential, so it fails closed: whatever token characters follow are redacted too.
    name: "longshore-token",
    re: /(?:lsi|ls|tt)_[A-Za-z0-9_-]{43}/g,
    maxLength: 4 + 43 + 1,
    run: "A-Za-z0-9_-",
  },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36,255}/g, maxLength: 4 + 255 + 1, run: "A-Za-z0-9" },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, maxLength: 21 },
  {
    name: "aws-secret-access-key",
    re: new RegExp(`(aws_secret_access_key["']?${WS}[:=]${GAP}["']?)[A-Za-z0-9/+=]{40}`, "gi"),
    maxLength: 21 + 1 + WS_MAX + 1 + GAP_MAX + 1 + 40,
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
    re: new RegExp(
      `(Authorization["']?${WS}[:=]${WS}["']?Bearer(?=\\s)${GAP})[A-Za-z0-9._~+/=-]{8,4096}`,
      "gi",
    ),
    maxLength: 13 + 1 + WS_MAX + 1 + WS_MAX + 1 + 6 + GAP_MAX + 4096,
    keepPrefix: true,
    run: "A-Za-z0-9._~+/=-",
  },
  {
    // The whole userinfo between `://` and the last `@` of the token is redacted: the username
    // may be empty, the password may hold `/`. `host:8080/x@y` therefore counts as userinfo (a
    // false positive we accept over a leak); without a later `@` in the token, a port is left
    // alone (see the long variants).
    name: "url-userinfo",
    re: /([a-z][a-z0-9+.-]{1,31}:\/\/)[^\s:@/?#]{0,256}:[^\s]{1,256}(?=@)/gi,
    maxLength: 32 + 3 + 256 + 1 + 256 + 1,
    keepPrefix: true,
    needs: "@",
  },
  {
    // A password past the bound above: redact it and the rest of the token, never skip it.
    name: "url-userinfo-long",
    re: /([a-z][a-z0-9+.-]{1,31}:\/\/)[^\s:@/?#]{0,256}:(?!\d{1,5}(?:\/|$)(?![^\s]*@))[^\s]{256}/gi,
    maxLength: 32 + 3 + 256 + 1 + 256,
    keepPrefix: true,
    needs: "://",
    run: "\\S",
  },
  {
    // An over-long username (no `:` within 256 characters): redact it and the rest of the token.
    name: "url-userinfo-long-user",
    re: /([a-z][a-z0-9+.-]{1,31}:\/\/)[^\s:@/?#]{257}/gi,
    maxLength: 32 + 3 + 257,
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
 * End of a line that names a key whose value may follow on a later line (whitespace only between,
 * see GAP). Built from the same WS as the patterns. Test it against the last KEY_LINE_SPAN
 * characters of one line, never the whole line.
 */
export const KEY_LINE_END = new RegExp(
  `(?:aws_secret_access_key["']?${WS}[:=]?${GAP_ON_LINE}["']?|Authorization["']?${WS}[:=]?${WS}["']?(?:B(?:e(?:a(?:r(?:e(?:r${GAP_ON_LINE})?)?)?)?)?)?)$`,
  "i",
);

/** Longest key-line ending KEY_LINE_END can match (Authorization form, plus slack). */
export const KEY_LINE_SPAN = 384;

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
