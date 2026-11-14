// Tick order 8 (spec section 7): collectors, belts, inserters, machines, then
// core repair. Solid items move one at a time; nothing reroutes around damage.

import type { Compiled, CompiledRecipe } from './compiled';
import type { Loose } from './loose';
import { addItem, refreshFuelAvail, type Ship } from './ship';
import type { Content } from './types';

export interface LogisticsStats {
  chunksCollected: number;
}

/** World position of a part's center, written to out[0], out[1]. */
export function partWorld(s: Ship, p: number, out: Float64Array): void {
  const dx = s.partX[p] + s.partW[p] / 2 - s.comX;
  const dy = s.partY[p] + s.partH[p] / 2 - s.comY;
  out[0] = s.x + s.cos * dx - s.sin * dy;
  out[1] = s.y + s.sin * dx + s.cos * dy;
}

const pos = new Float64Array(2);

/**
 * Collectors pull loose items within range toward themselves, at a fixed speed
 * relative to the ship, and take one in per intake interval while they have
 * buffer room. An item in range of several collectors goes to the first.
 */
export function stepCollectors(s: Ship, loose: Loose, content: Content, dt: number, stats: LogisticsStats): void {
  const k = content.constants.logistics;
  const range2 = k.collectorRange * k.collectorRange;
  const step = k.collectorPullSpeed * dt;
  for (let c = 0; c < s.collectors.length; c++) {
    const p = s.collectors[c];
    if (s.partAlive[p] && s.partTimer[p] > 0) s.partTimer[p]--;
  }
  for (let i = 0; i < loose.high; i++) {
    if (!loose.alive[i]) continue;
    for (let c = 0; c < s.collectors.length; c++) {
      const p = s.collectors[c];
      if (!s.partAlive[p]) continue;
      partWorld(s, p, pos);
      const dx = pos[0] - loose.x[i];
      const dy = pos[1] - loose.y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > range2) continue;
      const d = Math.sqrt(d2);
      if (d <= k.collectorGrabRadius && s.partTimer[p] === 0 && s.partItems[p] < k.collectorBuffer) {
        addItem(s, p, loose.item[i], 1);
        s.partTimer[p] = k.collectorIntakeTicks;
        loose.remove(i);
        stats.chunksCollected++;
      } else {
        // Ride along with the ship while being reeled in.
        loose.vx[i] = s.vx;
        loose.vy[i] = s.vy;
        if (d > step) {
          loose.x[i] += (dx / d) * step;
          loose.y[i] += (dy / d) * step;
        } else {
          loose.x[i] = pos[0];
          loose.y[i] = pos[1];
        }
      }
      break;
    }
  }
}

/** Belts: an item moves to the next belt once it has sat for the move time and there is room. */
export function stepBelts(s: Ship, content: Content): void {
  const moveTicks = content.constants.logistics.beltMoveTicks;
  for (let i = 0; i < s.nBelts; i++) {
    const p = s.beltOrder[i];
    if (s.beltItem[p] < 0) continue;
    if (s.partTimer[p] < moveTicks) s.partTimer[p]++;
    const next = s.beltNext[p];
    if (s.partTimer[p] >= moveTicks && next >= 0 && s.partAlive[next] && s.beltItem[next] < 0) {
      s.beltItem[next] = s.beltItem[p];
      s.partTimer[next] = 0;
      s.beltItem[p] = -1;
    }
  }
}

function recipeInputSlot(r: CompiledRecipe, item: number): number {
  for (let j = 0; j < r.inItems.length; j++) if (r.inItems[j] === item) return j;
  return -1;
}

/**
 * The recipe a machine would use to accept this item right now, or -1. A
 * machine with a fixed recipe takes its ingredients up to the buffer limit. One
 * that picks by input (the crusher) may switch only when idle and empty.
 */
function machineAccepts(s: Ship, p: number, item: number, content: Content, cc: Compiled): number {
  const crafts = content.constants.logistics.machineBufferCrafts;
  const current = s.partRecipe[p];
  if (current >= 0) {
    const r = cc.recipes[current];
    const slot = recipeInputSlot(r, item);
    if (slot >= 0) return s.inv[p * s.nItems + item] < crafts * r.inCounts[slot] ? current : -1;
    if (s.partFixedRecipe[p]) return -1;
  }
  if (s.partFixedRecipe[p] || s.partProgress[p] > 0 || s.partItems[p] > 0) return -1;
  const options = cc.recipesByMachine[s.partDef[p]];
  for (let j = 0; j < options.length; j++) {
    if (recipeInputSlot(cc.recipes[options[j]], item) >= 0) return options[j];
  }
  return -1;
}

/** Whether a destination part will take this item right now (spec section 7, Inserters). */
function accepts(s: Ship, p: number, item: number, content: Content, cc: Compiled): boolean {
  const def = s.defs[p];
  switch (def.kind) {
    case 'machine':
      return machineAccepts(s, p, item, content, cc) >= 0;
    case 'turret': {
      const t = cc.turrets[s.partDef[p]];
      return t !== null && t.ammo === item && s.inv[p * s.nItems + item] < t.def.ammoCapacity;
    }
    case 'core':
    case 'storage':
      return s.partItems[p] < (def.itemCapacity ?? 0);
    case 'belt':
      return s.beltItem[p] < 0;
    default:
      return false;
  }
}

/**
 * Inserters take from the cell behind them and drop into the cell in front,
 * one item per cycle, and only pick an item the destination accepts.
 */
export function stepInserters(s: Ship, content: Content, cc: Compiled): void {
  const n = s.nItems;
  for (let i = 0; i < s.inserters.length; i++) {
    const p = s.inserters[i];
    if (!s.partAlive[p]) continue;
    if (s.partTimer[p] > 0) {
      s.partTimer[p]--;
      continue;
    }
    if (s.insSrc[p] < 0 || s.insDst[p] < 0) continue;
    const src = s.cellPart[s.insSrc[p]];
    const dst = s.cellPart[s.insDst[p]];
    if (src < 0 || dst < 0) continue;
    const filter = s.insFilter[p];
    const srcKind = s.defs[src].kind;

    // Find the first item the source offers that passes the filter and the destination.
    let item = -1;
    if (srcKind === 'belt') {
      const it = s.beltItem[src];
      if (it >= 0 && (filter < 0 || filter === it) && accepts(s, dst, it, content, cc)) item = it;
    } else if (srcKind === 'machine') {
      const r = s.partRecipe[src];
      if (r >= 0) {
        const outs = cc.recipes[r].outItems;
        for (let j = 0; j < outs.length; j++) {
          const it = outs[j];
          if (s.inv[src * n + it] > 0 && (filter < 0 || filter === it) && accepts(s, dst, it, content, cc)) {
            item = it;
            break;
          }
        }
      }
    } else if (srcKind === 'collector' || srcKind === 'core' || srcKind === 'storage') {
      for (let it = 0; it < n; it++) {
        if (s.inv[src * n + it] > 0 && (filter < 0 || filter === it) && accepts(s, dst, it, content, cc)) {
          item = it;
          break;
        }
      }
    }
    if (item < 0) continue;

    if (srcKind === 'belt') s.beltItem[src] = -1;
    else addItem(s, src, item, -1);
    const dstKind = s.defs[dst].kind;
    if (dstKind === 'belt') {
      s.beltItem[dst] = item;
      s.partTimer[dst] = 0;
    } else {
      if (dstKind === 'machine') s.partRecipe[dst] = machineAccepts(s, dst, item, content, cc);
      addItem(s, dst, item, 1);
    }
    s.partTimer[p] = content.constants.logistics.inserterTicks;
  }
}

/**
 * Machines hold up to two crafts of input and two of output. A craft starts
 * when the ingredients (and any fuel) are there and the output has room, and
 * delivers when its time is up.
 */
export function stepMachines(s: Ship, content: Content, cc: Compiled): void {
  const n = s.nItems;
  const crafts = content.constants.logistics.machineBufferCrafts;
  for (let i = 0; i < s.machines.length; i++) {
    const p = s.machines[i];
    if (!s.partAlive[p]) continue;
    const ri = s.partRecipe[p];
    if (ri < 0) continue;
    const r = cc.recipes[ri];

    if (s.partProgress[p] > 0) {
      if (--s.partProgress[p] > 0) continue;
      for (let j = 0; j < r.outItems.length; j++) addItem(s, p, r.outItems[j], r.outCounts[j]);
      if (r.fuelOut > 0) addFuel(s, s.partNet[p], r.fuelOut);
      continue;
    }

    let ready = true;
    for (let j = 0; j < r.inItems.length && ready; j++) {
      if (s.inv[p * n + r.inItems[j]] < r.inCounts[j]) ready = false;
    }
    for (let j = 0; j < r.outItems.length && ready; j++) {
      if (s.inv[p * n + r.outItems[j]] + r.outCounts[j] > crafts * r.outCounts[j]) ready = false;
    }
    if (!ready) continue;
    const net = s.partNet[p];
    if (r.fuelIn > 0 || r.fuelOut > 0) {
      if (net < 0) continue;
      refreshFuelAvail(s);
      if (r.fuelIn > 0 && s.netAvail[net] < r.fuelIn) continue;
      if (r.fuelOut > 0 && fuelRoom(s, net) < r.fuelOut) continue;
      if (r.fuelIn > 0) addFuel(s, net, -r.fuelIn);
    }
    for (let j = 0; j < r.inItems.length; j++) addItem(s, p, r.inItems[j], -r.inCounts[j]);
    s.partProgress[p] = r.ticks;
  }
}

function fuelRoom(s: Ship, net: number): number {
  let room = 0;
  for (let p = 0; p < s.n; p++) {
    if (s.partAlive[p] && s.partNet[p] === net) room += (s.defs[p].fuelCapacity ?? 0) - s.partFuel[p];
  }
  return room;
}

/** Adds fuel to a network's tanks (first with room), or takes it (first with fuel). */
function addFuel(s: Ship, net: number, amount: number): void {
  for (let p = 0; p < s.n && amount !== 0; p++) {
    if (!s.partAlive[p] || s.partNet[p] !== net) continue;
    const cap = s.defs[p].fuelCapacity ?? 0;
    if (cap <= 0) continue;
    if (amount > 0) {
      const room = cap - s.partFuel[p];
      const add = amount < room ? amount : room;
      s.partFuel[p] += add;
      amount -= add;
    } else {
      const take = -amount < s.partFuel[p] ? -amount : s.partFuel[p];
      s.partFuel[p] -= take;
      amount += take;
    }
  }
}

/**
 * Core repair (spec section 5): while any part is damaged and the core holds
 * repair kits, one kit per interval restores HP to the damaged part nearest
 * the core. Destroyed parts are not rebuilt.
 */
export function stepRepair(s: Ship, content: Content, cc: Compiled): void {
  const k = content.constants.logistics;
  const core = s.corePart;
  if (s.repairTimer < k.repairTicks) s.repairTimer++;
  if (s.repairTimer < k.repairTicks || s.inv[core * s.nItems + cc.repairKit] <= 0) return;
  const cx = s.partX[core] + s.partW[core] / 2;
  const cy = s.partY[core] + s.partH[core] / 2;
  let best = -1;
  let bestD2 = Infinity;
  for (let p = 0; p < s.n; p++) {
    if (!s.partAlive[p] || s.partHp[p] >= s.defs[p].hp) continue;
    const dx = s.partX[p] + s.partW[p] / 2 - cx;
    const dy = s.partY[p] + s.partH[p] / 2 - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  if (best < 0) return;
  addItem(s, core, cc.repairKit, -1);
  const hp = s.partHp[best] + k.repairHp;
  s.partHp[best] = hp > s.defs[best].hp ? s.defs[best].hp : hp;
  s.repairTimer = 0;
}
