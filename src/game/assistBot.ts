// A scripted stand-in for an assisting player, so the balance harness can
// measure what the spec asks for while the toolkit is iterated: the gap
// between assisted and solo success, and taps per minute. It plays simply and
// with a reaction delay, like a first-time player who has understood the tools.

import { Sim, timeToImpact } from '../sim';
import type { AssistTarget, Content, Design, LaneDef, RunResult } from '../sim';

export interface BotOptions {
  /** Ticks between the bot deciding and the command landing. 9 ticks = 0.3 s. */
  reactionTicks: number;
  /** A part is worth a patch below this share of its HP. */
  patchBelow: number;
}

export const DEFAULT_BOT: BotOptions = { reactionTicks: 9, patchBelow: 0.6 };

/** Picks a target for a tool the way the bot plays it, or null to hold fire. */
function chooseTarget(sim: Sim, tool: string): AssistTarget | null {
  const s = sim.ship;
  const a = sim.asteroids;
  if (tool === 'deck_gun') {
    // The asteroid that will hit the hull soonest; rocks and larger before pebbles.
    const sizes = sim.content.asteroidSizes;
    const horizon = sim.content.turretRules.threatHorizonSeconds;
    let best = -1;
    let bestBig = false;
    let bestTime = 0;
    for (let i = 0; i < a.high; i++) {
      if (!a.alive[i]) continue;
      const t = timeToImpact(s, a, i, sizes[a.size[i]].radius, horizon);
      if (t < 0) continue;
      const big = sizes[a.size[i]].impactDamage >= 60;
      if (best < 0 || (big && !bestBig) || (big === bestBig && t < bestTime)) {
        best = i;
        bestBig = big;
        bestTime = t;
      }
    }
    return best < 0 ? null : { kind: 'asteroid', id: a.id[best] };
  }
  if (tool === 'patch') {
    let best = -1;
    let bestShare = DEFAULT_BOT.patchBelow;
    for (let p = 0; p < s.n; p++) {
      if (!s.partAlive[p]) continue;
      const share = s.partHp[p] / s.defs[p].hp;
      if (share < bestShare) {
        best = p;
        bestShare = share;
      }
    }
    return best < 0 ? null : { kind: 'part', part: best };
  }
  return null;
}

/** Flies a lane with the bot using whatever assist tools the lane offers. */
export function runAssisted(
  content: Content, design: Design, lane: LaneDef, seed: number, options: BotOptions = DEFAULT_BOT,
): RunResult {
  const sim = new Sim(content, design, lane, seed);
  const tools = lane.assist ?? [];
  const busyUntil = tools.map(() => 0);
  while (sim.outcome === 'running') {
    for (let i = 0; i < tools.length; i++) {
      const landing = sim.tick + options.reactionTicks;
      if (landing < sim.assistReady[i] || sim.tick < busyUntil[i]) continue;
      const target = chooseTarget(sim, tools[i].tool);
      if (!target) continue;
      sim.enqueue({ tick: landing, type: 'assist', tool: tools[i].tool, target });
      busyUntil[i] = landing + 1;
    }
    sim.step();
  }
  return sim.result();
}
