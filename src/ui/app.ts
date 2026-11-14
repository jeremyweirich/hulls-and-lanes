// The app shell: owns the save record, switches screens, persists, and runs
// readiness checks that outlive the screen that started them. Screens read
// the save and change it only through src/game's rules.

import { content, designs, lanes } from '../data';
import {
  accrueAll, isCurrent, newGame, storeBenchmark,
  type AccrualLine, type Benchmark, type SaveRecord, type SaveStore, type ShipRecord,
} from '../game';
import { startReadinessCheck, type ReadinessHandle } from '../game/readinessPool';
import { designHash, type Design, type LaneDef } from '../sim';
import type { Screen } from './dom';
import { toast } from './dom';
import { HubScreen } from './hub';
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

  /** Launch setup is not built yet. */
  readonly canLaunch = false;

  toLaunch(shipId: string): void {
    toast('Launch setup is next on the list.');
    void shipId;
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
