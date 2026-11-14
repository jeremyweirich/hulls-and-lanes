// The run report (spec section 12): outcome, cause, haul and an event timeline,
// then the ship's solo readiness once the check that follows every assisted
// run finishes. From here a certified ship can go straight to farming.

import { content } from '../data';
import {
  assignFarming, incomePerHour, isCertified, readiness, reportLines, type Benchmark,
} from '../game';
import type { RunResult, SimEvent } from '../sim';
import { App, type Check } from './app';
import { fill, h, toast, type Screen } from './dom';
import { duration, fmt, itemName, money } from './format';
import type { RunMode } from './run';

const CAUSE: Record<string, string> = {
  core_destroyed_by_impact: 'The core was destroyed.',
  left_lane: 'The ship drifted out of the lane for 10 s.',
  time_limit: 'Time ran out.',
  aborted: 'You aborted the run.',
};

function eventText(e: SimEvent): string {
  const part = (id: string) => content.parts.find((p) => p.id === id)?.name.toLowerCase() ?? id;
  switch (e.type) {
    case 'first_part_lost': return `First part lost: ${part(e.detail)}`;
    case 'part_lost': return `Lost ${part(e.detail)}`;
    case 'parts_detached': return `${e.detail} parts broke away`;
    case 'supply_ran_dry': return `Ran out of ${itemName(e.detail).toLowerCase()}`;
    case 'fuel_ran_dry': return 'Ran out of fuel';
    default: return e.type;
  }
}

export class ReportScreen implements Screen {
  readonly el: HTMLElement;
  private readonly readinessBox = h('div', { class: 'card' });
  private check: Check | null = null;
  private readonly onCheck = () => this.renderReadiness();

  constructor(
    private readonly app: App,
    private readonly shipId: string,
    private readonly laneId: string,
    result: RunResult,
    private readonly mode: RunMode,
    private readonly firstClear: boolean,
  ) {
    const lane = app.lane(laneId);
    const r = result;
    const good = r.outcome === 'success';
    const ship = app.ship(shipId);

    // Collapse long runs of part losses so the timeline stays readable.
    const timeline: SimEvent[] = [];
    let hidden = 0;
    for (const e of r.events) {
      if (e.type === 'part_lost' && timeline.filter((t) => t.type === 'part_lost').length >= 6) {
        hidden++;
        continue;
      }
      timeline.push(e);
    }

    const stats: [string, string][] = [
      ['Time', duration(r.seconds)],
      ['Reached', `${fmt(r.laneShare * 100)}% of ${lane.length} u`],
      ['Parts lost', String(r.partsLost)],
      ['Rounds fired', Object.entries(r.fired).map(([id, n]) => `${n} ${itemName(id).toLowerCase()}`).join(', ') || 'none'],
      ['Asteroids shot', String(r.asteroidsShot)],
      ['Chunks collected', String(r.chunksCollected)],
      ['Fuel left', fmt(r.fuelLeft)],
    ];
    const taps = Object.values(r.assistUses).reduce((a, b) => a + b, 0);
    if (this.mode === 'assisted') {
      stats.push(['Assist taps', `${taps}${r.seconds > 0 ? ` (${fmt((taps * 60) / r.seconds, 1)} a minute)` : ''}`]);
    }

    this.el = h('div', { class: 'screen report' },
      h('header', { class: 'bar' }, h('h1', null, 'Run report')),
      h('div', { class: 'scroll' },
        h('div', { class: `banner ${good ? 'good' : 'bad'}` },
          h('b', null, good ? 'Lane cleared' : 'Run failed'),
          h('span', null, good ? `${ship?.design.name ?? 'Ship'} reached the end of ${lane.name}.` : CAUSE[r.cause ?? ''] ?? r.cause)),
        this.firstClear ? h('div', { class: 'card gold' },
          h('b', null, `First clear of ${lane.name}.`),
          h('div', { class: 'sub' }, `+1 hangar slot (now ${app.save.unlocks.hangarSlots}). Ships certified here can now farm it.`)) : null,
        h('h3', null, this.mode === 'watch' ? 'Haul (not banked: watching only)' : good ? 'Haul banked' : 'Haul'),
        h('div', { class: 'card' }, good
          ? h('div', { class: 'big' }, money(r.haul) || 'Nothing: no plate reached the core or storage.')
          : h('div', { class: 'muted' }, 'Nothing is banked from a failed run.')),
        h('h3', null, 'Solo readiness'),
        this.readinessBox,
        h('h3', null, 'Run'),
        h('div', { class: 'card info' }, h('dl', null, stats.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
        h('h3', null, 'Timeline'),
        h('div', { class: 'card' },
          timeline.length ? h('ol', { class: 'timeline' }, timeline.map((e) =>
            h('li', null, h('span', { class: 'muted num' }, `${fmt(e.tick / 30)} s · ${fmt(e.laneShare * 100)}%`), ' ', eventText(e))))
            : h('div', { class: 'muted' }, 'Nothing went wrong.'),
          hidden ? h('div', { class: 'muted small' }, `…and ${hidden} more parts lost.`) : null),
      ),
      h('nav', { class: 'bottom-actions' },
        h('button', { class: 'btn', on: { click: () => app.toHub() } }, 'Hub'),
        h('button', { class: 'btn', on: { click: () => app.toShipyard(shipId) } }, 'Shipyard'),
        this.mode === 'assisted'
          ? h('button', { class: 'btn primary', on: { click: () => app.toRun(shipId, 'assisted') } }, 'Retry')
          : null),
    );
    this.check = app.benchmarkFor(shipId, laneId).check;
    this.renderReadiness();
  }

  mounted(): void {
    this.check?.listeners.add(this.onCheck);
    this.app.changed.add(this.onCheck);
  }

  dispose(): void {
    this.check?.listeners.delete(this.onCheck);
    this.app.changed.delete(this.onCheck);
  }

  private renderReadiness(): void {
    const app = this.app;
    if (!app.ship(this.shipId)) return;
    const { benchmark, check } = app.benchmarkFor(this.shipId, this.laneId);
    const runs = content.economy.readinessRuns;
    if (check) {
      const b = check.benchmark;
      fill(this.readinessBox,
        h('div', null, b ? `${Math.round(readiness(b) * 100)}% so far` : 'Starting…',
          h('span', { class: 'muted' }, `  ${b?.runs ?? 0} of ${runs} solo runs`)),
        h('progress', { max: runs, value: b?.runs ?? 0 }),
        h('div', { class: 'muted small' }, 'Flying the same 20 fields every design is tested on.'));
      return;
    }
    if (!benchmark) {
      fill(this.readinessBox,
        h('div', { class: 'muted' }, 'Not tested since the last change.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', on: { click: () => this.test() } }, 'Test readiness')));
      return;
    }
    fill(this.readinessBox, ...this.benchmarkView(benchmark));
  }

  private benchmarkView(b: Benchmark): HTMLElement[] {
    const app = this.app;
    const ship = app.ship(this.shipId)!;
    const lane = app.lane(this.laneId);
    const pct = Math.round(readiness(b) * 100);
    const certified = isCertified(content, b, ship.design, lane);
    const cleared = !!app.save.lanes[lane.id]?.cleared;
    const farmer = app.save.ships.find((s) => s.farming?.laneId === lane.id);
    const out: HTMLElement[] = [
      h('div', { class: 'big' }, h('b', { class: certified ? 'ok' : 'warn' }, `${pct}%`),
        certified ? ' certified' : ` — needs ${Math.round(lane.readinessThreshold * 100)}% to farm`),
      h('ul', { class: 'list' }, reportLines(content, b).map((l) => h('li', null, l))),
    ];
    if (certified) {
      out.push(h('div', null, `Farming would bring in ${money(incomePerHour(content, b)) || 'nothing'} an hour.`));
      if (farmer?.id === ship.id) out.push(h('div', { class: 'ok' }, `Farming ${lane.name}.`));
      else if (!cleared) out.push(h('div', { class: 'muted' }, `Clear ${lane.name} once to open farming.`));
      else {
        out.push(h('div', { class: 'actions' }, h('button', {
          class: 'btn primary', on: { click: () => this.farm() },
        }, farmer ? `Farm ${lane.name} instead of ${farmer.design.name}` : `Farm ${lane.name}`)));
      }
    } else {
      out.push(h('div', { class: 'muted small' }, 'Improve the design in the shipyard, then test again.'));
    }
    return out;
  }

  private test(): void {
    this.check?.listeners.delete(this.onCheck);
    this.check = this.app.startCheck(this.shipId, this.laneId);
    this.check.listeners.add(this.onCheck);
    this.renderReadiness();
  }

  private farm(): void {
    const save = this.app.save;
    const lane = this.app.lane(this.laneId);
    for (const s of save.ships) if (s.id !== this.shipId && s.farming?.laneId === lane.id) s.farming = null;
    const err = assignFarming(content, save, this.shipId, lane, App.now());
    if (err) {
      toast(err, 'bad');
      return;
    }
    void this.app.persist();
    toast(`${this.app.ship(this.shipId)!.design.name} is farming ${lane.name}.`);
    this.renderReadiness();
  }
}
