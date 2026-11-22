const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b & 31);
}

/**
 * Monotonic ULID: 10 chars of epoch ms + 16 chars of randomness, Crockford base32.
 * Within the same millisecond the random part increments, so ids sort in creation order.
 */
export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    now = lastTime;
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] === 31) lastRandom[i] = 0;
      else {
        lastRandom[i] = (lastRandom[i] ?? 0) + 1;
        break;
      }
    }
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + lastRandom.map((d) => ALPHABET[d]).join("");
}
