// A readiness check in Web Workers (spec section 10): the score fills in as
// runs finish, and the check can be cancelled.

import type { Content, Design, LaneDef, RunResult } from '../sim';
import { laneSeeds, summarize, type Benchmark } from './benchmark';
import type { ReadinessJob } from './readiness.worker';

export interface ReadinessHandle {
  cancel(): void;
}

/**
 * Starts a check. onProgress receives the benchmark so far after every run;
 * done is true on the last call. Results are summarized in seed order whatever
 * order the workers finish in, so the record is identical on every device.
 */
export function startReadinessCheck(
  content: Content, design: Design, lane: LaneDef,
  onProgress: (benchmark: Benchmark, done: boolean) => void,
  maxWorkers = 4,
): ReadinessHandle {
  const seeds = laneSeeds(lane.id, content.economy.readinessRuns);
  const results = new Map<number, RunResult>();
  const count = Math.max(1, Math.min(maxWorkers, navigator.hardwareConcurrency || 2, seeds.length));
  const workers: Worker[] = [];
  let cancelled = false;

  for (let w = 0; w < count; w++) {
    const worker = new Worker(new URL('./readiness.worker.ts', import.meta.url), { type: 'module' });
    workers.push(worker);
    worker.onmessage = (e: MessageEvent<RunResult>) => {
      if (cancelled) return;
      results.set(e.data.seed, e.data);
      const ordered = seeds.filter((s) => results.has(s)).map((s) => results.get(s)!);
      const done = ordered.length === seeds.length;
      if (done) for (const each of workers) each.terminate();
      onProgress(summarize(lane, design, ordered), done);
    };
    const job: ReadinessJob = { content, design, lane, seeds: seeds.filter((_, i) => i % count === w) };
    worker.postMessage(job);
  }

  return {
    cancel() {
      cancelled = true;
      for (const worker of workers) worker.terminate();
    },
  };
}
