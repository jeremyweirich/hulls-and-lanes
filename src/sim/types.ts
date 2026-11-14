// Shared data shapes for the simulation. Nothing in sim/ may import from
// render/, ui/ or the browser: this directory runs unchanged under Node.

/** Bumped by any change that alters run outcomes. Invalidates stored benchmarks. */
export const SIM_VERSION = 2;

export type Rot = 0 | 90 | 180 | 270;

export interface BehaviorConfig {
  id: string;
  [param: string]: number | string;
}

export interface PartInstance {
  type: string;
  /** Top-left cell of the rotated footprint. */
  x: number;
  y: number;
  /** Clockwise from "facing forward" (-y, up the screen). */
  rot: Rot;
  recipe?: string;
  filter?: string | null;
  behaviors?: BehaviorConfig[];
}

export interface Design {
  name: string;
  tiles: [number, number][];
  parts: PartInstance[];
}

export type PartKind =
  | 'tile' | 'core' | 'belt' | 'inserter' | 'collector' | 'machine' | 'storage'
  | 'tank' | 'pipe' | 'thruster' | 'computer' | 'turret' | 'armor' | 'generator' | 'shield';

export interface PartDef {
  id: string;
  name: string;
  /** Footprint at rot 0. */
  w: number;
  h: number;
  mass: number;
  hp: number;
  cost: Record<string, number>;
  tier: number;
  kind: PartKind;
  thrust?: number;
  /** Fuel per second at full throttle. */
  burn?: number;
  fuelCapacity?: number;
  itemCapacity?: number;
  slots?: number;
}

export interface AsteroidSizeDef {
  id: string;
  radius: number;
  hp: number;
  mass: number;
  impactDamage: number;
  targetClass: string;
  /** Cells the damage may carry on to after the struck one. -1 = no limit. */
  spillCells: number;
  /** Chunks dropped when shot down (never when rammed), each with dropChance. */
  dropChunks: number;
  dropChance: number;
  /** Size id it breaks into when shot down, and how many. */
  splitInto?: string;
  splitCount?: number;
}

export interface ItemDef {
  id: string;
  name: string;
  group: 'raw' | 'intermediate' | 'supply';
  /** Goes to the stockpile when a run succeeds. */
  bankable?: boolean;
}

export interface RecipeDef {
  id: string;
  /** Part id of the machine that runs it. */
  machine: string;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  seconds: number;
  /** Fuel taken from the machine's network per craft. */
  fuelIn?: number;
  /** Fuel delivered into the machine's network per craft. */
  fuelOut?: number;
}

export interface TurretDef {
  part: string;
  damageType: string;
  range: number;
  damage: number;
  shotsPerSecond: number;
  ammo: string;
  ammoCapacity: number;
  delivery: 'hitscan_spread';
  /** Hit chance = target radius / (distance * spreadFactor), capped at 1. */
  spreadFactor: number;
}

export interface TurretRules {
  targetingIntervalTicks: number;
  /** Targets a turret is this weak against are ignored unless nothing else is in range. */
  minMultiplier: number;
  threatHorizonSeconds: number;
  multipliers: Record<string, Record<string, number>>;
  turrets: TurretDef[];
}

export interface BehaviorDef {
  id: string;
  name: string;
  tier: number;
  channels: ('forward' | 'lateral' | 'heading')[];
  params: Record<string, { min: number; max: number; default: number }>;
  tuning?: Record<string, number>;
}

export interface LaneSegment {
  /** Lane distance where this segment ends. It starts where the previous one ended. */
  to: number;
  per100u: Record<string, number>;
  materials: Record<string, number>;
}

export interface LaneDef {
  id: string;
  name: string;
  from: string;
  to: string;
  length: number;
  width: number;
  maxSize: [number, number];
  referenceSpeed: number;
  readinessThreshold: number;
  allowance: Record<string, number>;
  /** No asteroids spawn before this lane distance. */
  clearStart: number;
  segments: LaneSegment[];
  encounters: unknown[];
  boss: unknown | null;
}

export interface Constants {
  tickRate: number;
  linearDragPerSecond: number;
  gyroTorque: number;
  itemMass: number;
  fuelMass: number;
  cargoRecomputeTicks: number;
  impactReferenceSpeed: number;
  restitution: number;
  autopilot: {
    conditionIntervalTicks: number;
    minActiveTicks: number;
    forceGain: number;
    headingGain: number;
    headingDamping: number;
    torqueWeight: number;
    /** Small penalty on gyro use, so thrusters carry steady torque when they can. */
    gyroReluctance: number;
    allocatorPasses: number;
  };
  spawn: {
    sliceLength: number;
    aheadDistance: number;
    behindDistance: number;
    maxLateralDrift: number;
    maxApproachDrift: number;
  };
  caps: { asteroids: number; projectiles: number; loose: number; enemies: number };
  logistics: {
    beltMoveTicks: number;
    inserterTicks: number;
    machineBufferCrafts: number;
    collectorRange: number;
    collectorPullSpeed: number;
    collectorGrabRadius: number;
    collectorIntakeTicks: number;
    collectorBuffer: number;
    repairTicks: number;
    repairHp: number;
    dropScatterSpeed: number;
  };
  run: { outOfLaneSeconds: number; timeLimitFactor: number };
}

/** All tunable data, passed into the sim so tests and the balance harness can vary it. */
export interface Content {
  constants: Constants;
  parts: PartDef[];
  asteroidSizes: AsteroidSizeDef[];
  materials: string[];
  behaviors: BehaviorDef[];
  items: ItemDef[];
  recipes: RecipeDef[];
  turretRules: TurretRules;
  economy: Economy;
}

export interface Economy {
  /** Solo runs per readiness check. */
  readinessRuns: number;
  /** Seconds between idle runs. */
  turnaroundSeconds: number;
  offlineCapHours: number;
  accrualIntervalSeconds: number;
  start: { stockpile: Record<string, number>; hangarSlots: number };
  hangarSlotsPerClear: number;
  maxHangarSlots: number;
}

/** Player input. Assist tools will add command types here; solo runs have none. */
export type SimCommand = { tick: number; type: 'abort' };

export type Outcome = 'running' | 'success' | 'failure';

export type FailureCause =
  | 'core_destroyed_by_impact'
  | 'left_lane'
  | 'time_limit'
  | 'aborted';

export interface SimEvent {
  tick: number;
  /** Share of the lane covered when it happened, 0..1. */
  laneShare: number;
  type: 'first_part_lost' | 'fuel_ran_dry' | 'part_lost' | 'parts_detached' | 'supply_ran_dry';
  /** Part type id, a count for parts_detached, or an item id for supply_ran_dry. */
  detail: string;
}

export interface RunResult {
  simVersion: number;
  laneId: string;
  seed: number;
  outcome: Exclude<Outcome, 'running'>;
  cause: FailureCause | null;
  ticks: number;
  seconds: number;
  /** Share of the lane's length the core reached, 0..1. */
  laneShare: number;
  partsLost: number;
  fuelLeft: number;
  /** Bankable materials in the core and storages. Empty unless the run succeeded. */
  haul: Record<string, number>;
  /** Rounds fired, by ammo item id. */
  fired: Record<string, number>;
  asteroidsShot: number;
  chunksCollected: number;
  events: SimEvent[];
  /** Hash of the final sim state. Must match across Node, Chromium and WebKit. */
  stateHash: string;
}
