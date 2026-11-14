// The app shell: owns the save record, switches screens, persists, and runs
// readiness checks that outlive the screen that started them. Screens read
// the save and change it only through src/game's rules.

import { content, designs, lanes } from '../data';
import {
  accrueAll, importSave, isCurrent, newGame, recordRun, storeBenchmark,
  type AccrualLine, type Benchmark, type SaveRecord, type SaveStore, type ShipRecord,
} from '../game';
import { startReadinessCheck, type ReadinessHandle } from '../game/readinessPool';
import { designHash, type Design, type LaneDef, type RunResult } from '../sim';
import type { Screen } from './dom';
import { h, sheet, toast } from './dom';
import { duration, money } from './format';
import { HubScreen } from './hub';
import { LaunchScreen } from './launch';
import { ReportScreen } from './report';
import { RunScreen, type RunMode } from './run';
import { ShipyardScreen } from './shipyard';

export interface Check {
  shipId: string;
  laneId: string;
  designHash: string;
  benchmark: Benchmark | null;
  done: boolean;
  handle: ReadinessHandle;
  listeners: Set<(c: Check) => void>;
}

export class App {
  private screen: Screen | null = null;
  private persistTimer = 0;
  private saving: Promise<void> = Promise.resolve();
  readonly checks = new Map<string, Check>();
  /** Listeners told when the save changes from outside the current screen (accrual, checks). */
  readonly changed = new Set<() => void>();

  constructor(readonly root: HTMLElement, readonly store: SaveStore, public save: SaveRecord) {}

  static async boot(root: HTMLElement, store: SaveStore): Promise<App> {
    let save: SaveRecord | null = null;
    try {
      save = await store.load();
    } catch (err) {
      console.error(err);
      toast('Could not read the save. Starting a new game.', 'bad');
    }
    const fresh = !save;
    if (!save) {
      save = newGame(content, designs.starter, (Math.random() * 2 ** 32) >>> 0);
      save.settings.createdAt = App.now();
    }
    const app = new App(root, store, save);
    if (fresh) await app.persist();
    return app;
  }

  /** Unix seconds. Idle progress trusts the device clock (spec section 14). */
  static now(): number {
    return Date.now() / 1000;
  }

  show(screen: Screen): void {
    this.screen?.dispose?.();
    this.root.textContent = '';
    this.root.append(screen.el);
    this.screen = screen;
    screen.mounted?.();
    window.scrollTo(0, 0);
  }

  toHub(): void {
    this.show(new HubScreen(this));
  }

  toShipyard(shipId: string): void {
    this.show(new ShipyardScreen(this, shipId));
  }

  toLaunch(shipId: string): void {
    this.show(new LaunchScreen(this, shipId));
  }

  toRun(shipId: string, mode: RunMode): void {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    this.show(new RunScreen(this, shipId, mode, seed));
  }

  toReport(shipId: string, laneId: string, result: RunResult, mode: RunMode, firstClear: boolean): void {
    this.show(new ReportScreen(this, shipId, laneId, result, mode, firstClear));
  }

  /**
   * Banks a finished assisted run, then starts the readiness check that follows
   * every assisted run (spec section 10) unless the design already has a
   * current benchmark. Returns whether this run cleared the lane for the first time.
   */
  recordRun(shipId: string, laneId: string, result: RunResult): boolean {
    const firstClear = recordRun(content, this.save, this.lane(laneId), result);
    void this.persist();
    const ship = this.ship(shipId);
    if (ship && !isCurrent(ship.benchmarks[laneId], ship.design)) this.startCheck(shipId, laneId);
    return firstClear;
  }

  /** Adds a ship to the hangar and saves. Returns its id. */
  addShip(design: Design): string {
    let n = 1;
    while (this.save.ships.some((s) => s.id === `s${n}`)) n++;
    const id = `s${n}`;
    this.save.ships.push({ id, design, salvagedParts: [], benchmarks: {}, farming: null });
    void this.persist();
    return id;
  }

  /** Replaces the whole save with an imported one. */
  async replaceSave(text: string): Promise<void> {
    const save = importSave(text);
    for (const c of this.checks.values()) c.handle.cancel();
    this.checks.clear();
    this.save = save;
    await this.persist();
    this.toHub();
  }

  async reset(): Promise<void> {
    for (const c of this.checks.values()) c.handle.cancel();
    this.checks.clear();
    this.save = newGame(content, designs.starter, (Math.random() * 2 ** 32) >>> 0);
    await this.persist();
    this.toHub();
  }

  /**
   * Accrues idle income now and once a minute while the app is open (spec
   * section 10), and shows what came in while the player was away.
   */
  startAccrual(): void {
    const lastSeen = typeof this.save.settings.lastSeen === 'number' ? this.save.settings.lastSeen : null;
    const lines = this.accrue();
    if (lines.length) this.showAway(lines, lastSeen);
    const every = content.economy.accrualIntervalSeconds * 1000;
    window.setInterval(() => {
      const got = this.accrue();
      const total: Record<string, number> = {};
      for (const l of got) for (const [id, n] of Object.entries(l.haul)) total[id] = (total[id] ?? 0) + n;
      if (money(total)) toast(`Farming brought in ${money(total)}.`);
    }, every);
    // Catch up as soon as the player comes back to the tab.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const seen = typeof this.save.settings.lastSeen === 'number' ? this.save.settings.lastSeen : null;
      const got = this.accrue();
      if (got.length) this.showAway(got, seen);
    });
  }

  private showAway(lines: AccrualLine[], lastSeen: number | null): void {
    const away = lastSeen ? App.now() - lastSeen : null;
    const total: Record<string, number> = {};
    for (const l of lines) for (const [id, n] of Object.entries(l.haul)) total[id] = (total[id] ?? 0) + n;
    sheet('While you were away', h('div', null,
      away !== null ? h('p', { class: 'muted' }, `Away for ${duration(away)}${away > content.economy.offlineCapHours * 3600 ? ` (farming pays for the first ${content.economy.offlineCapHours} h)` : ''}.`) : null,
      lines.map((l) => h('div', { class: 'card' },
        h('div', { class: 'head' }, h('h2', null, l.name), h('b', null, money(l.haul) || 'nothing')),
        h('div', { class: 'sub' }, `${l.runs} runs of ${this.lane(l.laneId).name}, ${l.successes} cleared`))),
      h('p', null, h('b', null, `Total: ${money(total) || 'nothing'}`), ' added to the stockpile.'),
    ));
  }

  get current(): Screen | null {
    return this.screen;
  }

  /** Saves after a short pause, so a burst of edits is one write. */
  persistSoon(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => void this.persist(), 400);
  }

  persist(): Promise<void> {
    clearTimeout(this.persistTimer);
    const snapshot = structuredClone(this.save);
    this.saving = this.saving.then(() => this.store.save(snapshot)).catch((err) => {
      console.error(err);
      toast('Saving failed.', 'bad');
    });
    return this.saving;
  }

  notify(): void {
    for (const fn of this.changed) fn();
  }

  ship(id: string): ShipRecord | undefined {
    return this.save.ships.find((s) => s.id === id);
  }

  lane(id = 'lane1'): LaneDef {
    return lanes[id];
  }

  /** Pays farming ships for runs finished since last time. */
  accrue(): AccrualLine[] {
    const lines = accrueAll(content, this.save, App.now());
    this.save.settings.lastSeen = App.now();
    // Accrual advances each farming ship's clock even with no payout, so always save.
    void this.persist();
    if (lines.length) this.notify();
    return lines;
  }

  /**
   * Starts (or joins) a readiness check of a ship on a lane. When it finishes,
   * the benchmark is stored if the ship's design has not changed meanwhile.
   */
  startCheck(shipId: string, laneId = 'lane1'): Check {
    const ship = this.ship(shipId)!;
    const hash = designHash(ship.design);
    const key = `${shipId}:${laneId}`;
    const running = this.checks.get(key);
    if (running && running.designHash === hash) return running;
    running?.handle.cancel();

    const design: Design = structuredClone(ship.design);
    const check: Check = {
      shipId, laneId, designHash: hash, benchmark: null, done: false,
      handle: { cancel() {} }, listeners: new Set(),
    };
    this.checks.set(key, check);
    check.handle = startReadinessCheck(content, design, this.lane(laneId), (b, done) => {
      check.benchmark = b;
      check.done = done;
      if (done) {
        const now = this.ship(shipId);
        if (now && designHash(now.design) === hash) {
          storeBenchmark(this.save, shipId, b);
          void this.persist();
        }
        this.notify();
      }
      for (const fn of check.listeners) fn(check);
    });
    return check;
  }

  /** A finished, current benchmark, or the live check if one is running for this design. */
  benchmarkFor(shipId: string, laneId = 'lane1'): { benchmark: Benchmark | null; check: Check | null } {
    const ship = this.ship(shipId);
    if (!ship) return { benchmark: null, check: null };
    const check = this.checks.get(`${shipId}:${laneId}`) ?? null;
    const live = check && check.designHash === designHash(ship.design) ? check : null;
    const stored = ship.benchmarks[laneId];
    return { benchmark: isCurrent(stored, ship.design) ? stored : null, check: live && !live.done ? live : null };
  }
}
