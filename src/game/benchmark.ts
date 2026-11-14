// Readiness checks and benchmarks (spec section 10). A check runs a design
// through a lane's fixed seeds with no input; the summary both certifies the
// ship and sets its idle income.

import { designHash, Hasher, runHeadless, seedFor, SIM_VERSION } from '../sim';
import type { Content, Design, LaneDef, RunResult } from '../sim';

export interface Benchmark {
  laneId: string;
  designHash: string;
  simVersion: number;
  runs: number;
  successes: number;
  meanSuccessSeconds: number;
  meanFailSeconds: number;
  /** Mean haul of the successful runs, by material. */
  meanHaul: Record<string, number>;
  failures: Record<string, number>;
  /** Things that went wrong along the way, in how many runs, and how far in on average. */
  notes: { event: string; runs: number; atLaneShare: number }[];
}

const SEED_STREAM = 7;

/**
 * The lane's fixed seeds. Every design is tested on the same fields, so scores
 * are repeatable and two designs can be compared fairly.
 */
export function laneSeeds(laneId: string, count: number): number[] {
  const base = parseInt(new Hasher().str(laneId).hex().slice(0, 8), 16);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(seedFor(base, SEED_STREAM, i));
  return out;
}

/** Turns the results of a check, finished or still running, into a benchmark record. */
export function summarize(lane: LaneDef, design: Design, results: RunResult[]): Benchmark {
  let successes = 0;
  let successSeconds = 0;
  let failSeconds = 0;
  const haul: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const noteRuns: Record<string, number> = {};
  const noteShare: Record<string, number> = {};

  for (const r of results) {
    if (r.outcome === 'success') {
      successes++;
      successSeconds += r.seconds;
      for (const [id, n] of Object.entries(r.haul)) haul[id] = (haul[id] ?? 0) + n;
    } else {
      failSeconds += r.seconds;
      failures[r.cause!] = (failures[r.cause!] ?? 0) + 1;
    }
    const seen = new Set<string>();
    for (const e of r.events) {
      const key = e.type === 'supply_ran_dry' ? `${e.detail}_ran_dry`
        : e.type === 'fuel_ran_dry' || e.type === 'first_part_lost' ? e.type : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      noteRuns[key] = (noteRuns[key] ?? 0) + 1;
      noteShare[key] = (noteShare[key] ?? 0) + e.laneShare;
    }
  }

  const fails = results.length - successes;
  const meanHaul: Record<string, number> = {};
  for (const [id, n] of Object.entries(haul)) meanHaul[id] = n / successes;
  return {
    laneId: lane.id,
    designHash: designHash(design),
    simVersion: SIM_VERSION,
    runs: results.length,
    successes,
    meanSuccessSeconds: successes ? successSeconds / successes : 0,
    meanFailSeconds: fails ? failSeconds / fails : 0,
    meanHaul,
    failures,
    notes: Object.keys(noteRuns).sort((a, b) => noteRuns[b] - noteRuns[a] || (a < b ? -1 : 1))
      .map((event) => ({ event, runs: noteRuns[event], atLaneShare: noteShare[event] / noteRuns[event] })),
  };
}

/** Runs a whole check on the calling thread. For Node, tests and the balance harness. */
export function runReadinessCheck(content: Content, design: Design, lane: LaneDef): Benchmark {
  const seeds = laneSeeds(lane.id, content.economy.readinessRuns);
  return summarize(lane, design, seeds.map((seed) => runHeadless(content, design, lane, seed)));
}

export function readiness(b: Benchmark): number {
  return b.runs > 0 ? b.successes / b.runs : 0;
}

/** A benchmark only counts for the exact design and sim version it was run on. */
export function isCurrent(b: Benchmark | undefined, design: Design): b is Benchmark {
  return !!b && b.simVersion === SIM_VERSION && b.designHash === designHash(design);
}

/** Certified: a complete, current benchmark at or above the lane's threshold. */
export function isCertified(content: Content, b: Benchmark | undefined, design: Design, lane: LaneDef): boolean {
  return isCurrent(b, design) && b.laneId === lane.id
    && b.runs >= content.economy.readinessRuns && readiness(b) >= lane.readinessThreshold;
}

const CAUSE_TEXT: Record<string, string> = {
  core_destroyed_by_impact: 'the core was destroyed',
  left_lane: 'the ship drifted out of the lane',
  time_limit: 'time ran out',
  aborted: 'the run was aborted',
};

function noteText(content: Content, event: string): string {
  if (event === 'fuel_ran_dry') return 'Ran out of fuel';
  if (event === 'first_part_lost') return 'Lost its first part';
  const id = event.replace(/_ran_dry$/, '');
  const item = content.items.find((it) => it.id === id);
  return `Ran out of ${(item?.name ?? id).toLowerCase()}`;
}

/** The plain-language report: "Failed 3 of 20. Ran out of slugs about 62% of the way in 9 runs." */
export function reportLines(content: Content, b: Benchmark): string[] {
  const fails = b.runs - b.successes;
  const lines: string[] = [];
  if (fails === 0) lines.push(`Cleared all ${b.runs} runs.`);
  else {
    const causes = Object.entries(b.failures).sort((x, y) => y[1] - x[1])
      .map(([cause, n]) => `${CAUSE_TEXT[cause] ?? cause} in ${n}`);
    lines.push(`Failed ${fails} of ${b.runs}: ${causes.join(', ')}.`);
  }
  for (const n of b.notes) {
    lines.push(`${noteText(content, n.event)} about ${Math.round(n.atLaneShare * 100)}% of the way in `
      + `${n.runs} ${n.runs === 1 ? 'run' : 'runs'}.`);
  }
  return lines;
}
