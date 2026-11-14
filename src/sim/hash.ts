// FNV-1a style hashing for state fingerprints and design hashes. Two
// independent 32-bit lanes give a 64-bit result without BigInt.

export class Hasher {
  private a = 0x811c9dc5;
  private b = 0x01000193 ^ 0x5bd1e995;
  private readonly f64 = new Float64Array(1);
  private readonly u32 = new Uint32Array(this.f64.buffer);

  int(v: number): this {
    v |= 0;
    this.a = Math.imul(this.a ^ v, 0x01000193);
    this.b = Math.imul(this.b ^ (v + 0x9e3779b9), 0x85ebca6b);
    this.b ^= this.b >>> 13;
    return this;
  }

  /** Hashes the exact bits of a double. */
  num(v: number): this {
    this.f64[0] = v;
    return this.int(this.u32[0]).int(this.u32[1]);
  }

  nums(arr: ArrayLike<number>, count: number): this {
    for (let i = 0; i < count; i++) this.num(arr[i]);
    return this;
  }

  ints(arr: ArrayLike<number>, count: number): this {
    for (let i = 0; i < count; i++) this.int(arr[i]);
    return this;
  }

  str(s: string): this {
    for (let i = 0; i < s.length; i++) this.int(s.charCodeAt(i));
    return this.int(s.length);
  }

  hex(): string {
    const h = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
    return h(this.a) + h(this.b);
  }
}

/** JSON with object keys sorted, so equal values always serialize the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
