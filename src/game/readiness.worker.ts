// Runs solo lane runs off the main thread, posting one result per seed.

import { runHeadless } from '../sim';
import type { Content, Design, LaneDef } from '../sim';

export interface ReadinessJob {
  content: Content;
  design: Design;
  lane: LaneDef;
  seeds: number[];
}

self.onmessage = (e: MessageEvent<ReadinessJob>) => {
  const { content, design, lane, seeds } = e.data;
  for (const seed of seeds) self.postMessage(runHeadless(content, design, lane, seed));
};
