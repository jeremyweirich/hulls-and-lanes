// The save record (spec section 14): the whole game state as one versioned
// JSON object, plus the stores that hold it.

import { SIM_VERSION } from '../sim';
import type { Content, Design } from '../sim';
import type { Benchmark } from './benchmark';
import type { Farming } from './idle';

export const SAVE_VERSION = 1;

export interface ShipRecord {
  id: string;
  design: Design;
  /** Part ids that came with a fixer-upper and refund nothing. */
  salvagedParts: number[];
  benchmarks: Record<string, Benchmark>;
  farming: Farming | null;
}

export interface SaveRecord {
  saveVersion: number;
  simVersion: number;
  seed: number;
  stockpile: Record<string, number>;
  unlocks: { parts: string[]; behaviors: string[]; hangarSlots: number };
  lanes: Record<string, { cleared: boolean }>;
  contracts: Record<string, string>;
  ships: ShipRecord[];
  blueprints: Design[];
  settings: Record<string, unknown>;
}

/** A new game: the starting stockpile, two hangar slots and the starter ship. */
export function newGame(content: Content, starter: Design, seed: number): SaveRecord {
  return {
    saveVersion: SAVE_VERSION,
    simVersion: SIM_VERSION,
    seed: seed >>> 0,
    stockpile: { iron_plate: 0, carbon: 0, alloy: 0, scrap: 0, ...content.economy.start.stockpile },
    unlocks: {
      parts: content.parts.filter((p) => p.tier === 1).map((p) => p.id),
      behaviors: content.behaviors.filter((b) => b.tier === 1).map((b) => b.id),
      hangarSlots: content.economy.start.hangarSlots,
    },
    lanes: {},
    contracts: {},
    ships: [{ id: 's1', design: structuredClone(starter), salvagedParts: [], benchmarks: {}, farming: null }],
    blueprints: [],
    settings: {},
  };
}

/** One step per past save version: MIGRATIONS[n] upgrades a version-n record to n + 1. */
const MIGRATIONS: Record<number, (old: any) => any> = {};

/**
 * Brings a loaded record up to date. A sim version change keeps ships and
 * benchmarks: each benchmark carries its own simVersion, so stale ones stop
 * certifying while farming carries on with the old numbers until a re-test.
 */
export function migrate(raw: unknown): SaveRecord {
  let rec = raw as any;
  if (!rec || typeof rec !== 'object' || typeof rec.saveVersion !== 'number') {
    throw new Error('This is not a Hulls & Lanes save.');
  }
  if (rec.saveVersion > SAVE_VERSION) throw new Error('This save comes from a newer version of the game.');
  while (rec.saveVersion < SAVE_VERSION) {
    const step = MIGRATIONS[rec.saveVersion];
    if (!step) throw new Error(`No migration from save version ${rec.saveVersion}.`);
    rec = step(rec);
  }
  rec.simVersion = SIM_VERSION;
  return rec as SaveRecord;
}

export function exportSave(save: SaveRecord): string {
  return JSON.stringify(save);
}

export function importSave(text: string): SaveRecord {
  return migrate(JSON.parse(text));
}

export interface SaveStore {
  load(): Promise<SaveRecord | null>;
  save(record: SaveRecord): Promise<void>;
}

export class MemoryStore implements SaveStore {
  private text: string | null = null;

  async load(): Promise<SaveRecord | null> {
    return this.text === null ? null : importSave(this.text);
  }

  async save(record: SaveRecord): Promise<void> {
    this.text = exportSave(record);
  }
}

/** The on-device store. One record under one key. */
export class IndexedDbStore implements SaveStore {
  constructor(private readonly dbName = 'hulls-and-lanes') {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('save');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async load(): Promise<SaveRecord | null> {
    const db = await this.open();
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        const req = db.transaction('save').objectStore('save').get('current');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return raw == null ? null : migrate(raw);
    } finally {
      db.close();
    }
  }

  async save(record: SaveRecord): Promise<void> {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('save', 'readwrite');
        tx.objectStore('save').put(record, 'current');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
}
