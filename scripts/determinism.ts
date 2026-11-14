// Determinism test: runs the fixed triples under Node and in each available
// browser engine, and compares every final-state hash with the stored values.
//   npm run determinism            check
//   npm run determinism -- --update   rewrite the stored hashes (bump SIM_VERSION too)

import { buildSync } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_VERSION } from '../src/sim';
import { runCases, type CaseResult } from './determinism-cases';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, '../tests/golden/determinism.json');
const update = process.argv.includes('--update');

const engines: Record<string, CaseResult[]> = { node: runCases() };
const skipped: string[] = [];

const bundle = buildSync({
  entryPoints: [join(here, 'determinism-cases.ts')],
  bundle: true, write: false, format: 'iife', target: 'es2020',
}).outputFiles[0].text;

let playwright: any = null;
try {
  playwright = createRequire(import.meta.url)('playwright');
} catch {
  skipped.push('chromium (Playwright is not installed)', 'webkit (Playwright is not installed)');
}
for (const name of playwright ? ['chromium', 'webkit'] : []) {
  let browser;
  try {
    browser = await playwright[name].launch();
  } catch (err) {
    skipped.push(`${name} (${String(err).split('\n')[0].slice(0, 80)})`);
    continue;
  }
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle });
  engines[name] = await page.evaluate('runDeterminismCases()');
  await browser.close();
}

let failed = false;
const reference = engines.node;
for (const [engine, results] of Object.entries(engines)) {
  const diffs = results.filter((r, i) => r.stateHash !== reference[i].stateHash || r.ticks !== reference[i].ticks);
  console.log(`${engine.padEnd(9)} ${results.length} cases, ${diffs.length} differ from node`);
  for (const d of diffs) console.log(`  ${d.id}: ${d.stateHash} (${d.outcome}, ${d.ticks} ticks)`);
  if (diffs.length) failed = true;
}
for (const s of skipped) console.log(`skipped   ${s}`);

if (update) {
  writeFileSync(goldenPath, JSON.stringify({ simVersion: SIM_VERSION, cases: reference }, null, 2) + '\n');
  console.log(`Wrote ${reference.length} hashes for simVersion ${SIM_VERSION}.`);
} else if (!existsSync(goldenPath)) {
  console.log('No stored hashes yet. Run with --update.');
  failed = true;
} else {
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { simVersion: number; cases: CaseResult[] };
  const changed = reference.filter((r) => golden.cases.find((g) => g.id === r.id)?.stateHash !== r.stateHash);
  if (golden.simVersion !== SIM_VERSION || changed.length || golden.cases.length !== reference.length) {
    console.log(`Stored hashes (simVersion ${golden.simVersion}) do not match: ${changed.map((c) => c.id).join(', ')}`);
    console.log('If the change in outcomes is intended, bump SIM_VERSION and run with --update.');
    failed = true;
  } else {
    console.log(`All ${reference.length} hashes match the stored values (simVersion ${SIM_VERSION}).`);
  }
}
process.exit(failed ? 1 : 0);
