// Flight debug page: runs the starter ship down Lane 1 with the sim stepped on
// the main thread at a fixed tick, and the renderer interpolating between ticks.

import { content, designs, lanes } from './data';
import { DebugRenderer } from './render/debugRenderer';
import { compile, coreWorldX, shipItemCount, Sim, totalFuel } from './sim';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const renderer = new DebugRenderer(canvas);
const params = new URLSearchParams(location.search);

const design = designs[params.get('design') ?? 'starter'] ?? designs.starter;
const cc = compile(content);
let seed = Number(params.get('seed') ?? 1) >>> 0;
let speed = Number(params.get('speed') ?? 1);
let paused = false;
let sim = new Sim(content, design, lanes.lane1, seed);
let acc = 0;
let last = performance.now();

function restart(): void {
  sim = new Sim(content, design, lanes.lane1, seed);
  acc = 0;
}

function frame(now: number): void {
  const tickSeconds = sim.dt;
  const elapsed = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!paused && sim.outcome === 'running') {
    acc += elapsed * speed;
    while (acc >= tickSeconds && sim.outcome === 'running') {
      sim.step();
      acc -= tickSeconds;
    }
  }
  renderer.draw(sim, sim.outcome === 'running' && !paused ? acc / tickSeconds : 1);

  const s = sim.ship;
  const slot = sim.autopilot.activeSlot();
  const lostEvents = sim.events.slice(-3)
    .map((e) => `  ${(e.tick / 30).toFixed(0)}s ${e.type.replace(/_/g, ' ')} ${e.detail}`);
  hud.textContent = [
    `${design.name}  ${sim.lane.name}  seed ${seed}  ${(sim.tick / 30).toFixed(1)} s`,
    `lane ${Math.max(0, (100 * sim.distance) / sim.lane.length).toFixed(0)}%   speed ${sim.forwardSpeed.toFixed(2)} u/s   x ${coreWorldX(s).toFixed(1)}`,
    `fuel ${totalFuel(s).toFixed(0)}   mass ${s.mass.toFixed(0)}   parts lost ${s.partsLost}   rocks ${sim.asteroids.live}`,
    `slugs ${shipItemCount(s, cc.itemIndex.slugs)}   fired ${sim.fired[cc.itemIndex.slugs]}   shot ${sim.asteroidsShot}`,
    `chunks ${sim.chunksCollected}   plate ${shipItemCount(s, cc.itemIndex.iron_plate)}`,
    `behavior: ${slot >= 0 ? sim.autopilot.slots[slot].def.name : 'none'}`,
    ...lostEvents,
    sim.outcome !== 'running' ? `state ${sim.stateHash()}` : '',
  ].join('\n');
  requestAnimationFrame(frame);
}

const pauseBtn = document.getElementById('pause')!;
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.setAttribute('aria-pressed', String(paused));
});
const speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-speed]'));
function setSpeed(value: number): void {
  speed = value;
  for (const b of speedButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === value));
}
for (const b of speedButtons) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
setSpeed(speed);
document.getElementById('restart')!.addEventListener('click', restart);
document.getElementById('next')!.addEventListener('click', () => {
  seed++;
  restart();
});
document.getElementById('abort')!.addEventListener('click', () => sim.enqueue({ tick: sim.tick, type: 'abort' }));
window.addEventListener('resize', () => renderer.resize());

// Lets tests and the console poke at the run.
Object.assign(window, { hl: { get sim() { return sim; }, step: (n: number) => { for (let i = 0; i < n; i++) sim.step(); } } });

requestAnimationFrame(frame);
