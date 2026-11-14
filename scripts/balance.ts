// Balance harness: runs a design down a lane for N seeds and prints the
// outcome of each, then readiness and failure causes.
//   npm run balance -- [--design starter] [--lane lane1] [--seeds 20] [--from 1]

import { readFileSync } from 'node:fs';
import { content, designs, lanes } from '../src/data';
import { runHeadless, type Design } from '../src/sim';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const designArg = arg('design', 'starter');
const design: Design = designs[designArg] ?? JSON.parse(readFileSync(designArg, 'utf8'));
const lane = lanes[arg('lane', 'lane1')];
if (!lane) throw new Error('Unknown lane.');
const count = Number(arg('seeds', '20'));
const from = Number(arg('from', '1'));

let successes = 0;
let ticks = 0;
const causes: Record<string, number> = {};
const t0 = performance.now();
for (let seed = from; seed < from + count; seed++) {
  const r = runHeadless(content, design, lane, seed);
  ticks += r.ticks;
  if (r.outcome === 'success') successes++;
  else causes[r.cause!] = (causes[r.cause!] ?? 0) + 1;
  const first = r.events.find((e) => e.type === 'first_part_lost');
  console.log(
    `seed ${String(seed).padStart(4)}  ${r.outcome.padEnd(7)} ${(r.cause ?? '').padEnd(26)}`
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
for (const [cause, n] of Object.entries(causes)) console.log(`  ${cause}: ${n}`);
console.log(`${ticks} ticks in ${ms.toFixed(0)} ms = ${((1000 * ms) / ticks).toFixed(2)} µs per tick`);
