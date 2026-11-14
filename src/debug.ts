// Flight debug page: runs the starter ship down Lane 1 with the sim stepped on
// the main thread at a fixed tick, and the renderer interpolating between ticks.

import { content, designs, lanes } from './data';
import { incomePerHour, isCertified, readiness, reportLines, type Benchmark } from './game';
import { startReadinessCheck, type ReadinessHandle } from './game/readinessPool';
import { DebugRenderer, type Mark } from './render/debugRenderer';
import { ASSIST_TOOLS, compile, coreWorldX, shipItemCount, Sim, totalFuel } from './sim';
import { resolveTarget } from './ui/targets';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const renderer = new DebugRenderer(canvas);
const params = new URLSearchParams(location.search);

const designNames = Object.keys(designs);
let designName = params.get('design') && designs[params.get('design')!] ? params.get('design')! : 'starter';
let design = designs[designName];
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
  while (marks.length && marks[0].until < now) marks.shift();
  renderer.draw(sim, sim.outcome === 'running' && !paused ? acc / tickSeconds : 1, marks);
  updateChips();

  const s = sim.ship;
  const slot = sim.autopilot.activeSlot();
  const lostEvents = sim.events.slice(-3)
    .map((e) => `  ${(e.tick / 30).toFixed(0)}s ${e.type.replace(/_/g, ' ')} ${e.detail}`);
  hud.textContent = [
    `${design.name}  ${sim.lane.name}  seed ${seed}  ${(sim.tick / 30).toFixed(1)} s`,
    `lane ${Math.max(0, (100 * sim.distance) / sim.lane.length).toFixed(0)}%   speed ${sim.forwardSpeed.toFixed(2)} u/s   x ${coreWorldX(s).toFixed(1)}`,
    `fuel ${totalFuel(s).toFixed(0)}   mass ${s.mass.toFixed(0)}   parts lost ${s.partsLost}   rocks ${sim.asteroids.live}`,
    `slugs ${shipItemCount(s, cc.itemIndex.slugs)}   fired ${sim.fired[cc.itemIndex.slugs]}   shot ${sim.asteroidsShot}`,
    `chunks ${sim.chunksCollected}   plate ${shipItemCount(s, cc.itemIndex.iron_plate)}   taps ${taps()}`,
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

// Assist tools. A tap in the view goes to the first ready tool that can use
// what was tapped: a damaged part for Patch, an asteroid for the Deck gun.
// The command is stamped with the next tick, so the run replays exactly.
const marks: Mark[] = [];
const assistBar = document.getElementById('assist')!;
const tools = lanes.lane1.assist ?? [];
const chips = tools.map((a) => {
  const chip = document.createElement('div');
  chip.className = 'chip';
  const label = document.createElement('span');
  const bar = document.createElement('i');
  chip.append(label, bar);
  assistBar.append(chip);
  return { chip, label, bar, name: ASSIST_TOOLS[a.tool].name };
});

function taps(): number {
  let n = 0;
  for (let i = 0; i < sim.assistUses.length; i++) n += sim.assistUses[i];
  return n;
}

function updateChips(): void {
  tools.forEach((a, i) => {
    const left = Math.max(0, sim.assistReady[i] - sim.tick) / 30;
    chips[i].chip.classList.toggle('ready', left === 0);
    chips[i].label.textContent = left === 0 ? `${chips[i].name}: tap` : `${chips[i].name} ${left.toFixed(1)}s`;
    chips[i].bar.style.width = `${100 * (1 - left / a.cooldownSeconds)}%`;
  });
}

canvas.addEventListener('pointerdown', (e) => {
  if (sim.outcome !== 'running') return;
  const [wx, wy] = renderer.toWorld(e.clientX, e.clientY);
  const until = performance.now() + 220;
  for (let i = 0; i < tools.length; i++) {
    const tool = ASSIST_TOOLS[tools[i].tool];
    const target = resolveTarget(sim, tool.targeting, wx, wy);
    if (!target) continue;
    if (sim.tick < sim.assistReady[i]) {
      marks.push({ kind: 'miss', x: wx, y: wy, until });
      return;
    }
    sim.enqueue({ tick: sim.tick, type: 'assist', tool: tool.id, target });
    marks.push({ kind: target.kind === 'part' ? 'ring' : 'shot', x: wx, y: wy, until });
    return;
  }
});

// Readiness check: 20 solo runs in workers, with the score filling in as they finish.
const panel = document.getElementById('panel')!;
let check: ReadinessHandle | null = null;
let lastBenchmark: Benchmark | null = null;

function showBenchmark(b: Benchmark, done: boolean): void {
  lastBenchmark = b;
  const lane = lanes.lane1;
  const total = content.economy.readinessRuns;
  const pct = Math.round(readiness(b) * 100);
  const certified = isCertified(content, b, design, lane);
  panel.textContent = '';
  const head = document.createElement('div');
  head.append(`${design.name} on ${lane.name}\nSolo readiness: `);
  const score = document.createElement('b');
  score.textContent = `${pct}%`;
  if (pct < lane.readinessThreshold * 100) score.className = 'low';
  head.append(score, done ? '' : `  (${b.runs} of ${total} runs)`);
  panel.append(head);
  if (!done) return;
  const income = Object.entries(incomePerHour(content, b))
    .map(([id, n]) => `${Math.round(n)} ${content.items.find((it) => it.id === id)?.name.toLowerCase() ?? id}`);
  const lines = [
    ...reportLines(content, b),
    certified ? `Certified. Farming would bring in ${income.join(', ') || 'nothing'} per hour.`
      : `Not certified: needs ${Math.round(lane.readinessThreshold * 100)}%.`,
  ];
  panel.append(lines.join('\n'));
}

function closePanel(): void {
  check?.cancel();
  check = null;
  panel.classList.remove('open');
}

document.getElementById('readiness')!.addEventListener('click', () => {
  if (panel.classList.contains('open')) {
    closePanel();
    return;
  }
  panel.classList.add('open');
  panel.textContent = 'Starting readiness check…';
  check = startReadinessCheck(content, design, lanes.lane1, showBenchmark);
});
document.getElementById('ship')!.addEventListener('click', () => {
  closePanel();
  designName = designNames[(designNames.indexOf(designName) + 1) % designNames.length];
  design = designs[designName];
  restart();
});

// Lets tests and the console poke at the run.
Object.assign(window, { hl: { get sim() { return sim; }, get benchmark() { return lastBenchmark; }, step: (n: number) => { for (let i = 0; i < n; i++) sim.step(); } } });

requestAnimationFrame(frame);
