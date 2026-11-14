// Seeded 32-bit randomness. Integer-only (Math.imul and shifts), so every
// engine produces the same sequence.

export const STREAM_SPAWN = 1;
export const STREAM_SPREAD = 2;
export const STREAM_LOOT = 3;

/** murmur3 finalizer: a well-mixed 32-bit hash of a 32-bit value. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combines a run seed, a stream id and a sub-key (a slice number, say) into one seed. */
export function seedFor(seed: number, stream: number, key = 0): number {
  let h = mix32((seed >>> 0) ^ 0x9e3779b9);
  h = mix32(h ^ Math.imul(stream + 1, 0x85ebca77));
  h = mix32(h ^ Math.imul(key + 1, 0xc2b2ae3d));
  return h;
}

/** mulberry32. Reseedable so hot paths never allocate a generator. */
export class Rng {
  private s = 0;

  constructor(seed = 0) {
    this.seed(seed);
  }

  seed(seed: number): void {
    this.s = seed >>> 0;
  }

  u32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  get state(): number {
    return this.s;
  }
}
