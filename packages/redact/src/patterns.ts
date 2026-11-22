/**
 * Built-in secret patterns. Every pattern is linear-time by construction: character classes
 * with explicit upper bounds, no nested or overlapping quantifiers, no backreferences. The
 * upper bounds also give each pattern a maximum match length, which sizes the streaming
 * carry-over window. A token longer than its bound is only redacted up to the bound.
 *
 * Only the key/value patterns (aws secret, bearer) may span a newline, so a YAML-style value on
 * the line after its key is still found; the redactor holds a trailing key line for that (see
 * KEY_LINE_END). Every other pattern is single-line (PEM blocks are handled separately), which
 * is what lets the redactor emit complete lines immediately.
 *
 * `keep` is the number of leading characters of the match to leave in place (a key name or
 * header prefix), taken from capture group 1; `keepTail` the same for trailing text.
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
  },
  {
    name: "github-fine-grained-pat",
    re: /\bgithub_pat_[A-Za-z0-9_]{22,255}/g,
    maxLength: 11 + 255 + 1,
  },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36,255}/g, maxLength: 4 + 255 + 1 },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, maxLength: 21 },
  {
    name: "aws-secret-access-key",
    re: /(aws_secret_access_key["']?\s{0,64}[:=]\s{0,64}["']?)[A-Za-z0-9/+=]{40}/gi,
    maxLength: 21 + 1 + 64 + 1 + 64 + 1 + 40,
    keepPrefix: true,
  },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,250}/g, maxLength: 5 + 250 + 1 },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{5,512}\.eyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{0,1024}/g,
    maxLength: 3 + 512 + 1 + 3 + 4096 + 1 + 1024 + 1,
  },
  {
    // Only inside an Authorization header, so prose like "Bearer authentication" is untouched.
    name: "bearer-token",
    re: /(Authorization["']?\s{0,16}[:=]\s{0,16}["']?Bearer\s{1,64})[A-Za-z0-9._~+/=-]{8,4096}/gi,
    maxLength: 13 + 1 + 16 + 1 + 16 + 1 + 6 + 64 + 4096,
    keepPrefix: true,
  },
  {
    name: "url-userinfo-password",
    re: /([a-z][a-z0-9+.-]{1,31}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,256}(?=@)/gi,
    maxLength: 32 + 3 + 256 + 1 + 256 + 1,
    keepPrefix: true,
    needs: "://",
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
