/** Shortest value we will register. Shorter values would redact ordinary words and numbers. */
export const MIN_SECRET_LENGTH = 8;

export type RegisterResult = { ok: true; forms: number } | { ok: false; reason: string };

/**
 * Exact secret values for one job, plus their base64 and URL-encoded forms. Create one per
 * job and share it with that job's redactors. Values are held in memory only.
 */
export class SecretRegistry {
  #forms = new Set<string>();
  #warn: (message: string) => void;

  constructor(opts: { warn?: (message: string) => void } = {}) {
    this.#warn = opts.warn ?? ((m) => console.warn(m));
  }

  /**
   * Registers a value and its derived forms. Refuses values shorter than 8 characters (warns,
   * never logs the value). Idempotent.
   */
  register(value: string): RegisterResult {
    if (value.length < MIN_SECRET_LENGTH) {
      const reason = `secret value shorter than ${MIN_SECRET_LENGTH} characters not registered for redaction`;
      this.#warn(`redact: ${reason}`);
      return { ok: false, reason };
    }
    const bytes = new TextEncoder().encode(value);
    const b64 = Buffer.from(bytes).toString("base64");
    const candidates = [
      ...alignedBase64(bytes),
      value,
      b64,
      b64.replace(/=+$/, ""),
      b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
      encodeURIComponent(value),
    ];
    let added = 0;
    for (const form of candidates) {
      // Derived forms must also clear the length floor (padding-stripped base64 can shrink).
      if (form.length >= MIN_SECRET_LENGTH && !this.#forms.has(form)) {
        this.#forms.add(form);
        added++;
      }
    }
    return { ok: true, forms: added };
  }

  /** All registered forms, longest first, so a long form wins over a prefix of it. */
  forms(): string[] {
    return [...this.#forms].toSorted((a, b) => b.length - a.length);
  }

  /** True when any registered form contains a newline (disables line-aware emission). */
  get hasNewline(): boolean {
    for (const f of this.#forms) if (f.includes("\n")) return true;
    return false;
  }

  /** Length of the longest registered form (0 when empty). */
  get maxLength(): number {
    let max = 0;
    for (const f of this.#forms) if (f.length > max) max = f.length;
    return max;
  }
}

/**
 * Base64 of `bytes` as it appears inside a larger base64 blob, at each of the 3 byte
 * alignments. The leading and trailing characters that also depend on neighbouring bytes are
 * dropped, leaving the characters fixed by the value alone. Standard and URL-safe alphabets,
 * no padding.
 */
function alignedBase64(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const dropLead = [0, 2, 3] as const;
  for (const pad of [0, 1, 2] as const) {
    const padded = new Uint8Array(pad + bytes.length);
    padded.set(bytes, pad);
    const enc = Buffer.from(padded).toString("base64").replace(/=+$/, "");
    const end = (pad + bytes.length) % 3 === 0 ? enc.length : enc.length - 1;
    const core = enc.slice(dropLead[pad], end);
    out.push(core, core.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return out;
}
