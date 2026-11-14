// The simulation: a pure function of (design, lane, seed, input queue).
// The same four inputs always produce the same run, in any engine. Nothing
// here reads the clock, the DOM or Math.random.

import { Asteroids, Spawner } from './asteroids';
import { Autopilot, type FlightView } from './autopilot';
import { collideAsteroids } from './collide';
import { checkLaunch } from './design';
import { wrapAngle } from './dmath';
import { Hasher } from './hash';
import {
  buildShip, coreWorldX, coreWorldY, loadFuel, placeGridPointAt, recomputeMass,
  resolveFuel, resolveStructure, totalFuel, updateRotation, type Ship,
} from './ship';
import {
  SIM_VERSION, type Content, type Design, type FailureCause, type LaneDef,
  type Outcome, type RunResult, type SimCommand, type SimEvent,
} from './types';

export class Sim implements FlightView {
  readonly content: Content;
  readonly lane: LaneDef;
  readonly seed: number;
  readonly ship: Ship;
  readonly asteroids: Asteroids;
  readonly autopilot: Autopilot;
  readonly dt: number;

  tick = 0;
  outcome: Outcome = 'running';
  cause: FailureCause | null = null;
  readonly events: SimEvent[] = [];
  /** Every command applied so far. Replaying it with the same seed reproduces the run. */
  readonly inputLog: SimCommand[] = [];

  private readonly spawner: Spawner;
  private readonly queue: SimCommand[];
  private queuePos = 0;
  private outOfLaneTicks = 0;
  private fuelDryLogged = false;
  private readonly timeLimitTicks: number;
  private readonly outOfLaneLimit: number;
  private readonly dragFactor: number;

  constructor(content: Content, design: Design, lane: LaneDef, seed: number, inputs: SimCommand[] = []) {
    const problems = checkLaunch(content, design, lane);
    if (problems.length) throw new Error('Cannot launch: ' + problems.join(' '));
    const k = content.constants;
    this.content = content;
    this.lane = lane;
    this.seed = seed >>> 0;
    this.dt = 1 / k.tickRate;
    this.queue = inputs.slice().sort((a, b) => a.tick - b.tick);
    this.timeLimitTicks = Math.ceil(k.run.timeLimitFactor * (lane.length / lane.referenceSpeed) * k.tickRate);
    this.outOfLaneLimit = k.run.outOfLaneSeconds * k.tickRate;
    // Linear drag as a per-tick factor: about 3% of speed lost each second.
    this.dragFactor = 1 - k.linearDragPerSecond * this.dt;

    // Load: fuel is split across the tanks. Ammo joins in with turrets.
    this.ship = buildShip(content, design);
    loadFuel(this.ship, lane.allowance.fuel ?? 0);
    recomputeMass(this.ship, content, false);

    // Start: core on the center line at lane distance 0, at rest, facing forward.
    const s = this.ship;
    const p = s.corePart;
    placeGridPointAt(s, s.partX[p] + s.partW[p] / 2, s.partY[p] + s.partH[p] / 2, 0, 0);
    s.prevX = s.x;
    s.prevY = s.y;

    this.asteroids = new Asteroids(k.caps.asteroids);
    this.spawner = new Spawner(content, lane, this.seed);
    this.autopilot = new Autopilot(content, design, s);
  }

  /** Queues a live command. It is applied at the start of its tick. */
  enqueue(cmd: SimCommand): void {
    if (cmd.tick < this.tick) cmd = { ...cmd, tick: this.tick };
    let i = this.queue.length;
    while (i > this.queuePos && this.queue[i - 1].tick > cmd.tick) i--;
    this.queue.splice(i, 0, cmd);
  }

  /** Lane distance the core has covered. */
  get distance(): number {
    return -coreWorldY(this.ship);
  }

  /** Speed down the lane, u/s. */
  get forwardSpeed(): number {
    return -this.ship.vy;
  }

  /** Advances one tick of 1/tickRate seconds. Does nothing once the run has ended. */
  step(): void {
    if (this.outcome !== 'running') return;
    const ship = this.ship;
    const asteroids = this.asteroids;
    const content = this.content;
    const dt = this.dt;

    // 1. Input commands stamped for this tick.
    while (this.queuePos < this.queue.length && this.queue[this.queuePos].tick <= this.tick) {
      const cmd = this.queue[this.queuePos++];
      this.inputLog.push(cmd);
      if (cmd.type === 'abort') {
        this.end('failure', 'aborted');
        return;
      }
    }

    // 2. Spawn the lane slices entering range.
    this.spawner.step(asteroids, this.distance);

    // 3. Autopilot: behaviors, then thruster throttles.
    this.autopilot.step(this);

    // 4. Fuel: scale throttles by what each network can deliver.
    const fuelBefore = this.fuelDryLogged ? 0 : totalFuel(ship);
    resolveFuel(ship, dt);
    if (!this.fuelDryLogged && fuelBefore > 0 && totalFuel(ship) <= 0) {
      this.fuelDryLogged = true;
      this.events.push({ tick: this.tick, type: 'fuel_ran_dry', detail: '' });
    }

    // 5. Integrate motion (semi-implicit Euler: velocity, then position).
    ship.prevX = ship.x;
    ship.prevY = ship.y;
    ship.prevTheta = ship.theta;
    let fx = 0;
    let fy = 0;
    let torque = ship.gyro * content.constants.gyroTorque;
    for (let t = 0; t < ship.nThr; t++) {
      const f = ship.thrEff[t] * ship.thrMax[t];
      if (f === 0) continue;
      const ax = f * ship.thrFx[t];
      const ay = f * ship.thrFy[t];
      fx += ax;
      fy += ay;
      torque += (ship.thrCx[t] - ship.comX) * ay - (ship.thrCy[t] - ship.comY) * ax;
    }
    ship.vx += ((ship.cos * fx - ship.sin * fy) / ship.mass) * dt;
    ship.vy += ((ship.sin * fx + ship.cos * fy) / ship.mass) * dt;
    ship.vx *= this.dragFactor;
    ship.vy *= this.dragFactor;
    ship.omega += (torque / ship.inertia) * dt;
    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;
    ship.theta = wrapAngle(ship.theta + ship.omega * dt);
    updateRotation(ship);

    const behind = coreWorldY(ship) + content.constants.spawn.behindDistance;
    for (let i = 0; i < asteroids.high; i++) {
      if (!asteroids.alive[i]) continue;
      asteroids.prevX[i] = asteroids.x[i];
      asteroids.prevY[i] = asteroids.y[i];
      asteroids.x[i] += asteroids.vx[i] * dt;
      asteroids.y[i] += asteroids.vy[i] * dt;
      if (asteroids.y[i] > behind) asteroids.remove(i);
    }

    // 6. Collisions and damage.
    collideAsteroids(ship, asteroids, content);

    // 7. Turrets, and 8. logistics, arrive with milestone 3.

    // 9. Structure: log losses, detach what is cut off, refresh mass properties.
    if (ship.structureDirty) {
      const before = ship.lostCount;
      resolveStructure(ship, content);
      const detached = ship.lostCount - before;
      this.drainLost();
      if (detached > 0) {
        this.events.push({ tick: this.tick, type: 'parts_detached', detail: String(detached) });
      }
    } else if (this.tick % content.constants.cargoRecomputeTicks === 0) {
      recomputeMass(ship, content, true);
    }

    // 10. End conditions. The first one met decides the result.
    this.tick++;
    if (ship.coreDestroyed) {
      this.end('failure', 'core_destroyed_by_impact');
      return;
    }
    if (this.distance >= this.lane.length) {
      this.end('success', null);
      return;
    }
    const x = coreWorldX(ship);
    if ((x < 0 ? -x : x) > this.lane.width / 2) {
      if (++this.outOfLaneTicks >= this.outOfLaneLimit) {
        this.end('failure', 'left_lane');
        return;
      }
    } else {
      this.outOfLaneTicks = 0;
    }
    if (this.tick >= this.timeLimitTicks) this.end('failure', 'time_limit');
  }

  private drainLost(): void {
    const ship = this.ship;
    for (let i = 0; i < ship.lostCount; i++) {
      const id = ship.defs[ship.lostQueue[i]].id;
      const first = !this.events.some((e) => e.type === 'first_part_lost');
      this.events.push({ tick: this.tick, type: first ? 'first_part_lost' : 'part_lost', detail: id });
    }
    ship.lostCount = 0;
  }

  private end(outcome: Outcome, cause: FailureCause | null): void {
    this.drainLost();
    this.outcome = outcome;
    this.cause = cause;
  }

  /** Fingerprint of everything that can influence the future of the run. */
  stateHash(): string {
    const s = this.ship;
    const a = this.asteroids;
    const h = new Hasher();
    h.int(SIM_VERSION).int(this.tick).int(this.seed).str(this.outcome).str(this.cause ?? '');
    h.int(this.spawner.nextSlice).int(this.outOfLaneTicks);
    h.num(s.x).num(s.y).num(s.vx).num(s.vy).num(s.theta).num(s.omega);
    h.num(s.mass).num(s.comX).num(s.comY).num(s.inertia).num(s.gyro);
    h.nums(s.partHp, s.n).ints(s.partAlive, s.n).nums(s.partFuel, s.n).ints(s.partNet, s.n);
    h.ints(s.cellTile, s.gw * s.gh).nums(s.cellHp, s.gw * s.gh);
    h.nums(s.thrThrottle, s.nThr).nums(s.thrEff, s.nThr);
    h.int(a.high).int(a.live);
    for (let i = 0; i < a.high; i++) {
      h.int(a.alive[i]);
      if (!a.alive[i]) continue;
      h.int(a.size[i]).int(a.material[i]);
      h.num(a.x[i]).num(a.y[i]).num(a.vx[i]).num(a.vy[i]).num(a.hp[i]);
    }
    for (const slot of this.autopilot.slots) h.int(slot.active ? 1 : 0).int(slot.activeSince);
    return h.hex();
  }

  result(): RunResult {
    if (this.outcome === 'running') throw new Error('The run has not ended.');
    const share = this.distance / this.lane.length;
    return {
      simVersion: SIM_VERSION,
      laneId: this.lane.id,
      seed: this.seed,
      outcome: this.outcome,
      cause: this.cause,
      ticks: this.tick,
      seconds: this.tick * this.dt,
      laneShare: share > 1 ? 1 : share > 0 ? share : 0,
      partsLost: this.ship.partsLost,
      fuelLeft: totalFuel(this.ship),
      events: this.events,
      stateHash: this.stateHash(),
    };
  }
}

/** Runs a whole lane with no rendering. Solo runs pass no inputs. */
export function runHeadless(
  content: Content, design: Design, lane: LaneDef, seed: number, inputs: SimCommand[] = [],
): RunResult {
  const sim = new Sim(content, design, lane, seed, inputs);
  while (sim.outcome === 'running') sim.step();
  return sim.result();
}
