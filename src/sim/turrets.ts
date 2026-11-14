// Tick order 7 (spec section 8): turrets acquire targets, fire and use ammo.
// Milestone 3 has the autocannon and asteroid targets; the damage table and
// targeting rules are already data, ready for more turrets and enemy ships.

import type { Asteroids } from './asteroids';
import type { Compiled, CompiledTurret } from './compiled';
import { partWorld } from './logistics';
import type { Loose } from './loose';
import type { Rng } from './rng';
import { addItem, type Ship } from './ship';
import type { Content, SimEvent } from './types';

/** What the turret step reads and writes. The sim passes itself. */
export interface CombatView {
  readonly tick: number;
  readonly ship: Ship;
  readonly asteroids: Asteroids;
  readonly loose: Loose;
  readonly content: Content;
  readonly compiled: Compiled;
  readonly spreadRng: Rng;
  readonly lootRng: Rng;
  readonly events: SimEvent[];
  /** Rounds fired, by item index. */
  readonly fired: Int32Array;
  /** 1 once an item's running dry has been logged. */
  readonly dryLogged: Uint8Array;
  asteroidsShot: number;
}

const pos = new Float64Array(2);

/**
 * Seconds until an asteroid reaches the hull if both keep their velocity, or
 * -1 if it will miss. The hull is the grid's bounding box grown by the
 * asteroid's radius; the ship's spin is ignored.
 */
function timeToImpact(s: Ship, a: Asteroids, i: number, radius: number, horizon: number): number {
  const dx = a.x[i] - s.x;
  const dy = a.y[i] - s.y;
  const gx = s.comX + s.cos * dx + s.sin * dy;
  const gy = s.comY - s.sin * dx + s.cos * dy;
  const rvx = a.vx[i] - s.vx;
  const rvy = a.vy[i] - s.vy;
  const vx = s.cos * rvx + s.sin * rvy;
  const vy = -s.sin * rvx + s.cos * rvy;
  let tMin = 0;
  let tMax = horizon;
  // Slab test, x then y.
  for (let axis = 0; axis < 2; axis++) {
    const g = axis === 0 ? gx : gy;
    const v = axis === 0 ? vx : vy;
    const lo = -radius;
    const hi = (axis === 0 ? s.gw : s.gh) + radius;
    if (v > -1e-9 && v < 1e-9) {
      if (g < lo || g > hi) return -1;
      continue;
    }
    let t1 = (lo - g) / v;
    let t2 = (hi - g) / v;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  return tMin;
}

/**
 * Targeting (spec section 8). In order: skip targets this turret is weak
 * against unless nothing else is in range; prefer asteroids on a collision
 * course, soonest impact first; otherwise the nearest.
 */
function acquire(view: CombatView, p: number, t: CompiledTurret, tx: number, ty: number): void {
  const s = view.ship;
  const a = view.asteroids;
  const rules = view.content.turretRules;
  const sizes = view.content.asteroidSizes;
  const range2 = t.def.range * t.def.range;
  let best = -1;
  let bestStrong = false;
  let bestImpact = -1;
  let bestD2 = 0;
  for (let i = 0; i < a.high; i++) {
    if (!a.alive[i]) continue;
    const dx = a.x[i] - tx;
    const dy = a.y[i] - ty;
    const d2 = dx * dx + dy * dy;
    if (d2 > range2) continue;
    const strong = t.sizeMultiplier[a.size[i]] >= rules.minMultiplier;
    const impact = timeToImpact(s, a, i, sizes[a.size[i]].radius, rules.threatHorizonSeconds);
    let better: boolean;
    if (best < 0) better = true;
    else if (strong !== bestStrong) better = strong;
    else if ((impact >= 0) !== (bestImpact >= 0)) better = impact >= 0;
    else if (impact >= 0) better = impact < bestImpact;
    else better = d2 < bestD2;
    if (better) {
      best = i;
      bestStrong = strong;
      bestImpact = impact;
      bestD2 = d2;
    }
  }
  s.turTarget[p] = best;
  s.turTargetId[p] = best >= 0 ? a.id[best] : -1;
}

/** An asteroid shot down: it drops chunks of its material and may split. */
export function shootDown(view: CombatView, i: number): void {
  const a = view.asteroids;
  const cc = view.compiled;
  const rng = view.lootRng;
  const def = view.content.asteroidSizes[a.size[i]];
  const scatter = view.content.constants.logistics.dropScatterSpeed;
  const x = a.x[i];
  const y = a.y[i];
  const vx = a.vx[i];
  const vy = a.vy[i];
  const material = a.material[i];
  const into = cc.splitInto[a.size[i]];
  a.remove(i);
  view.asteroidsShot++;

  for (let k = 0; k < def.dropChunks; k++) {
    if (rng.next() >= def.dropChance) continue;
    view.loose.add(
      cc.chunkOfMaterial[material],
      x + rng.range(-def.radius, def.radius) * 0.7,
      y + rng.range(-def.radius, def.radius) * 0.7,
      vx + rng.range(-scatter, scatter),
      vy + rng.range(-scatter, scatter),
    );
  }
  if (into >= 0) {
    const child = view.content.asteroidSizes[into];
    for (let k = 0; k < (def.splitCount ?? 0); k++) {
      const ox = rng.range(-def.radius, def.radius) * 0.5;
      const oy = rng.range(-def.radius, def.radius) * 0.5;
      const svx = rng.range(-scatter, scatter) * 2;
      const svy = rng.range(-scatter, scatter) * 2;
      if (a.live < a.cap) a.add(into, material, x + ox, y + oy, vx + svx, vy + svy, child.hp);
    }
  }
}

export function stepTurrets(view: CombatView): void {
  const s = view.ship;
  const a = view.asteroids;
  const cc = view.compiled;
  const interval = view.content.turretRules.targetingIntervalTicks;
  const sizes = view.content.asteroidSizes;

  for (let i = 0; i < s.turrets.length; i++) {
    const p = s.turrets[i];
    if (!s.partAlive[p]) continue;
    const t = cc.turrets[s.partDef[p]];
    if (!t) continue;
    if (s.turCooldown[p] > 0) s.turCooldown[p] -= 1;
    partWorld(s, p, pos);
    const tx = pos[0];
    const ty = pos[1];

    // Drop a target that died, was replaced in its slot, or left range.
    let target = s.turTarget[p];
    let dist = 0;
    if (target >= 0) {
      if (!a.alive[target] || a.id[target] !== s.turTargetId[p]) target = -1;
      else {
        const dx = a.x[target] - tx;
        const dy = a.y[target] - ty;
        dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > t.def.range) target = -1;
      }
      s.turTarget[p] = target;
    }
    if (target < 0 || view.tick % interval === 0) {
      acquire(view, p, t, tx, ty);
      target = s.turTarget[p];
      if (target >= 0) {
        const dx = a.x[target] - tx;
        const dy = a.y[target] - ty;
        dist = Math.sqrt(dx * dx + dy * dy);
      }
    }
    if (target < 0 || s.turCooldown[p] > 0) {
      // No banking of shots while idle.
      if (s.turCooldown[p] < 0) s.turCooldown[p] = 0;
      continue;
    }

    if (s.inv[p * s.nItems + t.ammo] <= 0) {
      s.turCooldown[p] = 0;
      if (!view.dryLogged[t.ammo]) {
        view.dryLogged[t.ammo] = 1;
        view.events.push({ tick: view.tick, type: 'supply_ran_dry', detail: view.content.items[t.ammo].id });
      }
      continue;
    }

    addItem(s, p, t.ammo, -1);
    view.fired[t.ammo]++;
    s.turCooldown[p] += t.cooldownTicks;
    // Hit-scan with spread: small, distant targets are often missed.
    const roll = view.spreadRng.next();
    const size = a.size[target];
    const chance = dist > 0 ? sizes[size].radius / (dist * t.def.spreadFactor) : 1;
    if (roll >= chance) continue;
    a.hp[target] -= t.def.damage * t.sizeMultiplier[size];
    if (a.hp[target] <= 0) {
      shootDown(view, target);
      s.turTarget[p] = -1;
    }
  }
}
