// The fixed (design, lane, seed) triples of the determinism test. Bundled for
// browsers by scripts/determinism.ts and imported directly under Node.

import { content, designs, lanes } from '../src/data';
import { dcos, datan2, dsin, Hasher, runHeadless, type Design } from '../src/sim';

/** A lopsided two-slot ship, to exercise torque control and Center in lane. */
const lopsided: Design = {
  name: 'Lopsided',
  tiles: [
    ...Array.from({ length: 49 }, (_, i) => [i % 7, Math.floor(i / 7)] as [number, number]),
    [0, 7], [0, 8], [5, 7], [5, 8],
  ],
  parts: [
    { type: 'core', x: 1, y: 2, rot: 0 },
    { type: 'computer_mk1', x: 0, y: 3, rot: 0, behaviors: [{ id: 'drive_forward', cruise: 9 }] },
    { type: 'fuel_tank', x: 1, y: 5, rot: 0 },
    { type: 'fuel_pipe', x: 0, y: 6, rot: 0 },
    { type: 'fuel_pipe', x: 3, y: 6, rot: 0 },
    { type: 'fuel_pipe', x: 4, y: 6, rot: 0 },
    { type: 'fuel_pipe', x: 5, y: 6, rot: 0 },
    { type: 'thruster', x: 0, y: 7, rot: 180 },
    { type: 'thruster', x: 5, y: 7, rot: 180 },
    { type: 'storage', x: 5, y: 0, rot: 0 },
    { type: 'autocannon', x: 5, y: 2, rot: 0 },
    { type: 'armor', x: 6, y: 4, rot: 0 },
    { type: 'armor', x: 6, y: 5, rot: 0 },
  ],
};

export interface CaseResult {
  id: string;
  outcome: string;
  ticks: number;
  stateHash: string;
}

export function runCases(): CaseResult[] {
  const out: CaseResult[] = [];
  for (const [name, design] of [
    ['starter', designs.starter], ['reference1', designs.reference1], ['lopsided', lopsided],
  ] as const) {
    for (const seed of [1, 2, 3, 6, 9, 1234567, 4294967295]) {
      const r = runHeadless(content, design, lanes.lane1, seed);
      out.push({ id: `${name}/lane1/${seed}`, outcome: r.cause ?? r.outcome, ticks: r.ticks, stateHash: r.stateHash });
    }
  }
  // The math layer on its own, so a trig mismatch is reported as such.
  const h = new Hasher();
  for (let i = -5000; i <= 5000; i++) {
    const a = i * 0.00731;
    h.num(dsin(a)).num(dcos(a)).num(datan2(dsin(a), dcos(a) + 0.25));
  }
  out.push({ id: 'math', outcome: '', ticks: 0, stateHash: h.hex() });
  return out;
}

(globalThis as { runDeterminismCases?: typeof runCases }).runDeterminismCases = runCases;
