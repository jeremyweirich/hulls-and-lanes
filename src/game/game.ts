// Hub-side rules over a save record: costs, banking a run, certification,
// farming assignments and accrual. No browser APIs, so all of it runs in tests.

import { designHash } from '../sim';
import type { Content, Design, LaneDef, RunResult } from '../sim';
import { isCertified, type Benchmark } from './benchmark';
import { accrue } from './idle';
import type { SaveRecord, ShipRecord } from './save';

/** Materials to build a design from nothing: its platform tiles and parts. */
export function designCost(content: Content, design: Design): Record<string, number> {
  const cost: Record<string, number> = {};
  const add = (c: Record<string, number>, times: number) => {
    for (const [id, n] of Object.entries(c)) cost[id] = (cost[id] ?? 0) + n * times;
  };
  add(content.parts.find((p) => p.kind === 'tile')!.cost, design.tiles.length);
  for (const p of design.parts) add(content.parts.find((d) => d.id === p.type)!.cost, 1);
  return cost;
}

export function canAfford(save: SaveRecord, cost: Record<string, number>): boolean {
  return Object.entries(cost).every(([id, n]) => (save.stockpile[id] ?? 0) >= n);
}

export function findShip(save: SaveRecord, shipId: string): ShipRecord {
  const ship = save.ships.find((s) => s.id === shipId);
  if (!ship) throw new Error(`No ship "${shipId}".`);
  return ship;
}

function bank(save: SaveRecord, haul: Record<string, number>): void {
  for (const [id, n] of Object.entries(haul)) save.stockpile[id] = (save.stockpile[id] ?? 0) + n;
}

/**
 * Applies a finished live run. A success banks its haul; the first success on
 * a lane marks it cleared and adds a hangar slot. A failure changes nothing.
 * Returns whether this run cleared the lane for the first time.
 */
export function recordRun(content: Content, save: SaveRecord, lane: LaneDef, result: RunResult): boolean {
  if (result.outcome !== 'success') return false;
  bank(save, result.haul);
  if (save.lanes[lane.id]?.cleared) return false;
  save.lanes[lane.id] = { cleared: true };
  const eco = content.economy;
  save.unlocks.hangarSlots = Math.min(eco.maxHangarSlots, save.unlocks.hangarSlots + eco.hangarSlotsPerClear);
  return true;
}

export function storeBenchmark(save: SaveRecord, shipId: string, b: Benchmark): void {
  findShip(save, shipId).benchmarks[b.laneId] = b;
}

/**
 * Replaces a ship's design. Any change clears certification on every lane (the
 * stored benchmarks no longer match the design hash) and ends its farming.
 */
export function updateDesign(save: SaveRecord, shipId: string, design: Design): void {
  const ship = findShip(save, shipId);
  if (designHash(design) !== designHash(ship.design)) ship.farming = null;
  ship.design = design;
}

/**
 * Assigns a certified ship to idle-farm its lane: one ship per lane, one lane
 * per ship. Returns a reason when it cannot, or null on success.
 */
export function assignFarming(
  content: Content, save: SaveRecord, shipId: string, lane: LaneDef, now: number,
): string | null {
  const ship = findShip(save, shipId);
  if (!save.lanes[lane.id]?.cleared) return `${lane.name} has not been cleared yet.`;
  if (!isCertified(content, ship.benchmarks[lane.id], ship.design, lane)) {
    return `This ship is not certified for ${lane.name}.`;
  }
  if (save.ships.some((s) => s.id !== shipId && s.farming?.laneId === lane.id)) {
    return `Another ship is already farming ${lane.name}.`;
  }
  ship.farming = { laneId: lane.id, accruedUntil: now, counter: 0 };
  return null;
}

export function stopFarming(save: SaveRecord, shipId: string): void {
  findShip(save, shipId).farming = null;
}

export interface AccrualLine {
  shipId: string;
  name: string;
  laneId: string;
  runs: number;
  successes: number;
  haul: Record<string, number>;
}

/**
 * Pays every farming ship for the runs finished since its last accrual. Called
 * when the app opens and once a minute while it is open. Returns one line per
 * ship that completed at least one run, for the "while you were away" summary.
 */
export function accrueAll(content: Content, save: SaveRecord, now: number): AccrualLine[] {
  const lines: AccrualLine[] = [];
  for (const ship of save.ships) {
    if (!ship.farming) continue;
    const b = ship.benchmarks[ship.farming.laneId];
    if (!b) continue;
    const result = accrue(content, b, ship.farming, now, save.seed, ship.id);
    ship.farming = result.farming;
    if (result.runs === 0) continue;
    bank(save, result.haul);
    lines.push({
      shipId: ship.id, name: ship.design.name, laneId: b.laneId,
      runs: result.runs, successes: result.successes, haul: result.haul,
    });
  }
  return lines;
}
