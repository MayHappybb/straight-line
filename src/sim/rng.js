// Small deterministic PRNG so a car (and a run) can be reproduced from its seed.

/** Mix integers into one 32-bit seed (used to derive independent streams). */
export function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    let x = (p | 0) >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      x >>>= 8;
    }
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
    this.spare = null;
  }

  /** Uniform in [0, 1) — mulberry32. */
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(a, b) {
    return a + (b - a) * this.next();
  }

  /** Standard normal (Box–Muller, caches the second value). */
  gauss() {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const m = Math.sqrt(-2 * Math.log(u));
    this.spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  }

  normal(mu, sigma) {
    return mu + sigma * this.gauss();
  }

  /** Normal truncated to mu ± limit (resampled, not clipped, so no pile-up at the edges). */
  truncNormal(mu, sigma, limit) {
    for (let i = 0; i < 32; i++) {
      const x = this.gauss() * sigma;
      if (Math.abs(x) <= limit) return mu + x;
    }
    return mu;
  }

  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
}
