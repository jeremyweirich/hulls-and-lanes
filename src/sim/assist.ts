// Assist tools (spec section 13): the only way the player acts during a run.
// The toolkit is expected to change a lot, so everything about a tool lives
// here and in lane data. A tool never touches sim state: it returns effects,
// which the sim applies at the command's tick, so assisted runs stay
// deterministic and replay exactly.
//
// To add a tool: add an entry to ASSIST_TOOLS, and list it under "assist" in
// the lanes that offer it. If it needs a new kind of effect, add that to
// AssistEffect and to Sim.applyEffect.

import type { Asteroids } from './asteroids';
import type { Ship } from './ship';
import type { Content } from './types';

/** What the player tapped. Asteroids are named by their unique id, not their slot. */
export type AssistTarget =
  | { kind: 'asteroid'; id: number }
  | { kind: 'part'; part: number }
  | { kind: 'point'; x: number; y: number };

export type AssistEffect =
  | { type: 'damage_asteroid'; id: number; damage: number; damageType: string }
  | { type: 'heal_part'; part: number; hp: number }
  /** A push on the ship, in lane space, as a change in momentum. */
  | { type: 'impulse'; x: number; y: number };

export interface AssistView {
  readonly tick: number;
  readonly ship: Ship;
  readonly asteroids: Asteroids;
  readonly content: Content;
}

export interface AssistTool {
  id: string;
  name: string;
  targeting: 'none' | 'point' | 'part' | 'asteroid' | 'enemy';
  /**
   * Runs inside the sim at the stamped tick. Returns the effects to apply, or
   * nothing if the target is no longer valid, in which case no cooldown is spent.
   * params are the tool's numbers from lane data.
   */
  activate(view: AssistView, target: AssistTarget | null, params: Record<string, number>): AssistEffect[];
}

/** Slot of the live asteroid with this id, or -1. */
export function asteroidSlot(asteroids: Asteroids, id: number): number {
  for (let i = 0; i < asteroids.high; i++) if (asteroids.alive[i] && asteroids.id[i] === id) return i;
  return -1;
}

export const ASSIST_TOOLS: Record<string, AssistTool> = {
  deck_gun: {
    id: 'deck_gun',
    name: 'Deck gun',
    targeting: 'asteroid',
    activate(view, target, params) {
      if (target?.kind !== 'asteroid' || asteroidSlot(view.asteroids, target.id) < 0) return [];
      return [{ type: 'damage_asteroid', id: target.id, damage: params.damage, damageType: 'kinetic' }];
    },
  },
  patch: {
    id: 'patch',
    name: 'Patch',
    targeting: 'part',
    activate(view, target, params) {
      if (target?.kind !== 'part') return [];
      const s = view.ship;
      const p = target.part;
      if (!(p >= 0 && p < s.n) || !s.partAlive[p] || s.partHp[p] >= s.defs[p].hp) return [];
      return [{ type: 'heal_part', part: p, hp: params.hp }];
    },
  },
};
