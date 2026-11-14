import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runCases } from '../scripts/determinism-cases';
import { SIM_VERSION } from '../src/sim';

// The Node half of the determinism test. `npm run determinism` adds browsers.
it('matches the stored final-state hashes', () => {
  const golden = JSON.parse(readFileSync(new URL('./golden/determinism.json', import.meta.url), 'utf8'));
  expect(golden.simVersion).toBe(SIM_VERSION);
  expect(runCases()).toEqual(golden.cases);
});
