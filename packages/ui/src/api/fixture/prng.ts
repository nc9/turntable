/** Small deterministic PRNG (mulberry32) so fixture data is stable across reloads. */
export type Rng = {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
};

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRng(seed: number | string): Rng {
  let a = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p) => next() < p,
  };
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** ULID-shaped id: 10 time chars + 16 random chars. Not cryptographic; fixture only. */
export function fakeUlid(rng: Rng, time: number): string {
  let t = time;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = ALPHABET[t % 32] + head;
    t = Math.floor(t / 32);
  }
  let tail = "";
  for (let i = 0; i < 16; i++) tail += ALPHABET[rng.int(0, 31)];
  return head + tail;
}
