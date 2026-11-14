// What a tap in the run view means for an assist tool. Reads sim state only;
// the result becomes a command through sim.enqueue().

import type { AssistTarget, Sim } from '../sim';

/** The target a tool would get from a tap at a lane-space point, or null. */
export function resolveTarget(sim: Sim, targeting: string, wx: number, wy: number): AssistTarget | null {
  const s = sim.ship;
  if (targeting === 'part') {
    // Into grid space, then the nearest damaged part within a cell and a half.
    const dx = wx - s.x;
    const dy = wy - s.y;
    const gx = s.comX + s.cos * dx + s.sin * dy;
    const gy = s.comY - s.sin * dx + s.cos * dy;
    let best = -1;
    let bestD = 1.5;
    for (let p = 0; p < s.n; p++) {
      if (!s.partAlive[p] || s.partHp[p] >= s.defs[p].hp) continue;
      const ex = Math.max(s.partX[p] - gx, 0, gx - s.partX[p] - s.partW[p]);
      const ey = Math.max(s.partY[p] - gy, 0, gy - s.partY[p] - s.partH[p]);
      const d = Math.hypot(ex, ey);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best < 0 ? null : { kind: 'part', part: best };
  }
  if (targeting === 'asteroid') {
    // The nearest asteroid whose edge is within a thumb's width of the tap.
    const a = sim.asteroids;
    let best = -1;
    let bestD = 2;
    for (let i = 0; i < a.high; i++) {
      if (!a.alive[i]) continue;
      const d = Math.hypot(a.x[i] - wx, a.y[i] - wy) - sim.content.asteroidSizes[a.size[i]].radius;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? null : { kind: 'asteroid', id: a.id[best] };
  }
  return null;
}

/** The ship part under a lane-space point, or -1. For inspecting parts while paused. */
export function partAtPoint(sim: Sim, wx: number, wy: number): number {
  const s = sim.ship;
  const dx = wx - s.x;
  const dy = wy - s.y;
  const gx = s.comX + s.cos * dx + s.sin * dy;
  const gy = s.comY - s.sin * dx + s.cos * dy;
  for (let p = 0; p < s.n; p++) {
    if (!s.partAlive[p]) continue;
    if (gx >= s.partX[p] && gx < s.partX[p] + s.partW[p] && gy >= s.partY[p] && gy < s.partY[p] + s.partH[p]) return p;
  }
  return -1;
}
