import { describe, expect, it } from 'vitest';
import { canonicalJson, datan2, dcos, dsin, Hasher, PI, Rng, seedFor, STREAM_LOOT, STREAM_SPAWN, wrapAngle } from '../src/sim';

describe('deterministic trig', () => {
  it('matches the built-ins closely over a wide range', () => {
    for (let i = -2000; i <= 2000; i++) {
      const a = i * 0.0137;
      expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-12);
      expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-12);
    }
  });

  it('is exact at the cardinal angles', () => {
    expect(dsin(0)).toBe(0);
    expect(dcos(0)).toBe(1);
    expect(Math.abs(dsin(PI))).toBeLessThan(1e-15);
    expect(Math.abs(dcos(PI / 2))).toBeLessThan(1e-15);
  });

  it('atan2 matches the built-in in every quadrant', () => {
    for (let i = 0; i < 720; i++) {
      const a = (i / 720) * 2 * PI - PI + 0.001;
      const r = 0.3 + (i % 7);
      const got = datan2(r * Math.sin(a), r * Math.cos(a));
      expect(Math.abs(got - Math.atan2(r * Math.sin(a), r * Math.cos(a)))).toBeLessThan(1e-10);
    }
    expect(datan2(0, 0)).toBe(0);
    expect(datan2(1, 0)).toBeCloseTo(PI / 2, 12);
    expect(datan2(0, -1)).toBeCloseTo(PI, 12);
  });

  it('wraps angles into [-PI, PI]', () => {
    expect(wrapAngle(0.5)).toBe(0.5);
    expect(wrapAngle(3 * PI)).toBeCloseTo(-PI, 12);
    expect(wrapAngle(-PI - 0.25)).toBeCloseTo(PI - 0.25, 12);
    expect(wrapAngle(100)).toBeCloseTo(100 - 32 * PI, 9);
  });
});

describe('rng', () => {
  it('produces a fixed sequence for a seed', () => {
    // Golden values: a change here means every stored benchmark is invalid.
    const r = new Rng(12345);
    expect([r.u32(), r.u32(), r.u32(), r.u32()]).toEqual([4207900869, 1317490944, 2079646450, 3513001552]);
  });

  it('stays in range and is roughly uniform', () => {
    const r = new Rng(7);
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 20000).toBeGreaterThan(0.49);
    expect(sum / 20000).toBeLessThan(0.51);
  });

  it('gives each stream and key its own seed', () => {
    const seen = new Set<number>();
    for (let key = 0; key < 500; key++) {
      seen.add(seedFor(42, STREAM_SPAWN, key));
      seen.add(seedFor(42, STREAM_LOOT, key));
      seen.add(seedFor(43, STREAM_SPAWN, key));
    }
    expect(seen.size).toBe(1500);
  });
});

describe('hashing', () => {
  it('distinguishes the bits of doubles', () => {
    expect(new Hasher().num(0.1 + 0.2).hex()).not.toBe(new Hasher().num(0.3).hex());
    expect(new Hasher().num(1.5).hex()).toBe(new Hasher().num(1.5).hex());
  });

  it('canonical JSON sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }))
      .toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});
