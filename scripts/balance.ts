// Balance harness: runs a design down a lane for N seeds and prints the
// outcome of each, then readiness and failure causes.
//   npm run balance -- [--design starter] [--lane lane1] [--seeds 20] [--from 1]

import { readFileSync } from 'node:fs';
import { content, designs, lanes } from '../src/data';
import { incomePerHour, laneSeeds, readiness, reportLines, summarize } from '../src/game';
import { runHeadless, type Design, type RunResult } from '../src/sim';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const designArg = arg('design', 'starter');
const design: Design = designs[designArg] ?? JSON.parse(readFileSync(designArg, 'utf8'));
const lane = lanes[arg('lane', 'lane1')];
if (!lane) throw new Error('Unknown lane.');
// By default this is the lane's own readiness check: its fixed seeds. Pass
// --seeds and --from to sweep other seeds instead.
const fixed = !args.includes('--seeds') && !args.includes('--from');
const count = Number(arg('seeds', String(content.economy.readinessRuns)));
const from = Number(arg('from', '1'));
const seeds = fixed ? laneSeeds(lane.id, count) : Array.from({ length: count }, (_, i) => from + i);
const results: RunResult[] = [];

let successes = 0;
let ticks = 0;
const t0 = performance.now();
for (const seed of seeds) {
  const r = runHeadless(content, design, lane, seed);
  results.push(r);
  ticks += r.ticks;
  if (r.outcome === 'success') successes++;
  const first = r.events.find((e) => e.type === 'first_part_lost');
  console.log(
    `seed ${String(seed).padStart(10)}  ${r.outcome.padEnd(7)} ${(r.cause ?? '').padEnd(26)}`
    + `${r.seconds.toFixed(1).padStart(7)} s  lane ${(r.laneShare * 100).toFixed(0).padStart(3)}%`
    + `  lost ${String(r.partsLost).padStart(2)}  fuel ${r.fuelLeft.toFixed(0).padStart(4)}`
    + `  fired ${String(r.fired.slugs ?? 0).padStart(4)}  shot ${String(r.asteroidsShot).padStart(3)}`
    + `  chunks ${String(r.chunksCollected).padStart(3)}  haul ${JSON.stringify(r.haul)}`
    + (first ? `  first loss: ${first.detail} @ ${(first.tick / 30).toFixed(0)} s` : ''),
  );
}
const ms = performance.now() - t0;
console.log(`\n${design.name} on ${lane.name}: readiness ${successes}/${count}`
  + ` (${((100 * successes) / count).toFixed(0)}%)`);
const b = summarize(lane, design, results);
for (const line of reportLines(content, b)) console.log('  ' + line);
if (readiness(b) > 0) {
  const income = Object.entries(incomePerHour(content, b)).map(([id, n]) => `${n.toFixed(0)} ${id}`).join(', ');
  console.log(`  Idle income if farmed: ${income || 'nothing'} per hour`);
}
console.log(`${ticks} ticks in ${ms.toFixed(0)} ms = ${((1000 * ms) / ticks).toFixed(2)} µs per tick`);
