// Idle farming (spec section 10). Income comes from the ship's benchmark, so no
// simulation runs while the app is closed.

import { Hasher, Rng, seedFor } from '../sim';
import type { Content } from '../sim';
import { readiness, type Benchmark } from './benchmark';

export interface Farming {
  laneId: string;
  /** Unix seconds up to which runs have been paid out. */
  accruedUntil: number;
  /** Counts accruals, so each one draws fresh randomness. */
  counter: number;
}

export interface Accrual {
  runs: number;
  successes: number;
  haul: Record<string, number>;
  farming: Farming;
}

const ACCRUAL_STREAM = 11;

/** Seconds per idle cycle: the expected run time plus turnaround. */
export function cycleSeconds(content: Content, b: Benchmark): number {
  const p = readiness(b);
  return p * b.meanSuccessSeconds + (1 - p) * b.meanFailSeconds + content.economy.turnaroundSeconds;
}

/** Expected haul per hour, by material. This is the number shown in the hub. */
export function incomePerHour(content: Content, b: Benchmark): Record<string, number> {
  const perHour = (3600 / cycleSeconds(content, b)) * readiness(b);
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(b.meanHaul)) out[id] = perHour * n;
  return out;
}

/**
 * Pays out the idle runs completed since the last accrual. Successes are a
 * binomial draw, seeded by the save, the ship and the accrual counter, so
 * reloading a save cannot reroll them.
 *
 * Time away beyond the offline cap is dropped. The spec advances accruedUntil
 * by the cycles paid, which would leave the excess to be paid at the next
 * accrual; here only the part-finished cycle carries over.
 */
export function accrue(
  content: Content, b: Benchmark, farming: Farming, now: number, saveSeed: number, shipId: string,
): Accrual {
  const none: Accrual = { runs: 0, successes: 0, haul: {}, farming };
  // A clock that moved backward pays nothing and restarts from now.
  if (now < farming.accruedUntil) return { ...none, farming: { ...farming, accruedUntil: now } };

  const cycle = cycleSeconds(content, b);
  const cap = content.economy.offlineCapHours * 3600;
  const elapsed = Math.min(now - farming.accruedUntil, cap);
  const runs = Math.floor(elapsed / cycle);
  if (runs === 0) return none;

  const p = readiness(b);
  const shipKey = parseInt(new Hasher().str(shipId).hex().slice(0, 8), 16);
  const rng = new Rng(seedFor(saveSeed ^ shipKey, ACCRUAL_STREAM, farming.counter));
  let successes = 0;
  for (let i = 0; i < runs; i++) if (rng.next() < p) successes++;

  const haul: Record<string, number> = {};
  for (const [id, n] of Object.entries(b.meanHaul)) {
    const amount = Math.floor(successes * n);
    if (amount > 0) haul[id] = amount;
  }
  return {
    runs,
    successes,
    haul,
    farming: {
      laneId: farming.laneId,
      accruedUntil: now - (elapsed - runs * cycle),
      counter: farming.counter + 1,
    },
  };
}
