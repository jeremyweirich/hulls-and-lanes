import { content } from '../src/data';
import type { Design, LaneDef, PartInstance, Rot } from '../src/sim';

export { content };

/** A filled rectangle of tiles. */
export function rect(x0: number, y0: number, w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push([x, y]);
  return out;
}

export function part(type: string, x: number, y: number, rot: Rot = 0, extra: Partial<PartInstance> = {}): PartInstance {
  return { type, x, y, rot, ...extra };
}

export function design(tiles: [number, number][], parts: PartInstance[]): Design {
  return { name: 'test', tiles, parts };
}

/**
 * A 5x9 test ship: core in the middle, tank behind it, and a rear thruster on
 * each side fed by pipes. Symmetric about x = 2.5.
 *   y0-1 bare, y2-4 core (x1-3), y5-6 tank (x1-2) + pipes, y7-8 thrusters at x0 and x4.
 */
export function twinThruster(extraParts: PartInstance[] = [], extraTiles: [number, number][] = []): Design {
  return design(
    [...rect(0, 0, 5, 7), [0, 7], [0, 8], [4, 7], [4, 8], ...extraTiles],
    [
      part('core', 1, 2),
      part('computer_mk1', 0, 3, 0, { behaviors: [{ id: 'drive_forward', cruise: 6 }] }),
      part('fuel_tank', 1, 5),
      part('fuel_pipe', 0, 6),
      part('fuel_pipe', 3, 6),
      part('fuel_pipe', 4, 6),
      part('thruster', 0, 7, 180),
      part('thruster', 4, 7, 180),
      ...extraParts,
    ],
  );
}

/** A lane with no asteroids, for flight tests. */
export function emptyLane(overrides: Partial<LaneDef> = {}): LaneDef {
  return {
    id: 'test', name: 'Test lane', from: 'a', to: 'b',
    length: 300, width: 40, maxSize: [20, 20], referenceSpeed: 6, readinessThreshold: 0.8,
    allowance: { fuel: 150 }, clearStart: 0, segments: [], encounters: [], boss: null,
    ...overrides,
  };
}
