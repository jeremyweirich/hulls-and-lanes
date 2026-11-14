// Flight computer (spec section 6). A prioritized list of behaviors sets up to
// three targets (forward speed, sideways speed, heading); the allocator then
// finds the thruster throttles that best deliver them. It can only use
// thrusters that exist and have fuel, so a good behavior on a badly built ship
// still flies badly.

import { wrapAngle } from './dmath';
import { coreWorldX, refreshFuelAvail, type Ship } from './ship';
import type { BehaviorConfig, BehaviorDef, Content, Design, LaneDef } from './types';

/** What a behavior may read. The sim passes itself. */
export interface FlightView {
  readonly tick: number;
  readonly ship: Ship;
  readonly lane: LaneDef;
  readonly content: Content;
}

export interface Targets {
  hasForward: boolean;
  hasLateral: boolean;
  hasHeading: boolean;
  /** Speed down the lane, u/s. */
  forward: number;
  /** Speed toward +x, u/s. */
  lateral: number;
  /** Radians; 0 is straight down the lane. */
  heading: number;
}

/**
 * A behavior is data (behaviors.json) plus these two functions. To add one,
 * register it here; nothing else in the sim changes.
 */
export interface BehaviorImpl {
  condition(view: FlightView, cfg: BehaviorConfig, def: BehaviorDef): boolean;
  /** Writes the target for each channel the behavior claims and has been granted. */
  apply(view: FlightView, cfg: BehaviorConfig, def: BehaviorDef, targets: Targets,
    forward: boolean, lateral: boolean, heading: boolean): void;
}

export const BEHAVIORS: Record<string, BehaviorImpl> = {
  drive_forward: {
    condition: () => true,
    apply(_view, cfg, def, targets, forward) {
      if (forward) targets.forward = param(cfg, def, 'cruise');
    },
  },
  center_in_lane: {
    condition(view, _cfg, def) {
      const x = coreWorldX(view.ship);
      return (x < 0 ? -x : x) > (view.lane.width / 2) * def.tuning!.triggerShare;
    },
    apply(view, _cfg, def, targets, _forward, lateral) {
      if (!lateral) return;
      const max = def.tuning!.maxSpeed;
      const v = -coreWorldX(view.ship) * def.tuning!.gain;
      targets.lateral = v > max ? max : v < -max ? -max : v;
    },
  },
};

function param(cfg: BehaviorConfig, def: BehaviorDef, name: string): number {
  const spec = def.params[name];
  const raw = cfg[name];
  const v = typeof raw === 'number' ? raw : spec.default;
  return v < spec.min ? spec.min : v > spec.max ? spec.max : v;
}

interface Slot {
  cfg: BehaviorConfig;
  def: BehaviorDef;
  impl: BehaviorImpl;
  active: boolean;
  activeSince: number;
}

export class Autopilot {
  readonly slots: Slot[] = [];
  readonly targets: Targets = {
    hasForward: false, hasLateral: false, hasHeading: false, forward: 0, lateral: 0, heading: 0,
  };

  constructor(content: Content, design: Design, ship: Ship) {
    if (ship.computerPart < 0) return;
    for (const cfg of design.parts[ship.computerPart].behaviors ?? []) {
      const def = content.behaviors.find((d) => d.id === cfg.id);
      const impl = BEHAVIORS[cfg.id];
      if (!def || !impl) throw new Error(`Behavior "${cfg.id}" is not implemented.`);
      this.slots.push({ cfg, def, impl, active: false, activeSince: 0 });
    }
  }

  /** Index of the highest-priority active behavior, or -1. For the run view. */
  activeSlot(): number {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].active) return i;
    return -1;
  }

  /** Tick order 3: evaluate behaviors, then compute thruster throttles. */
  step(view: FlightView): void {
    const ship = view.ship;
    const k = view.content.constants;
    const ap = k.autopilot;

    // No computer, or it was destroyed: nothing fires and the gyro is off.
    if (ship.computerPart < 0 || !ship.partAlive[ship.computerPart]) {
      for (let t = 0; t < ship.nThr; t++) ship.thrThrottle[t] = 0;
      ship.gyro = 0;
      return;
    }

    // Conditions are re-checked on an interval, and a behavior that switched on
    // stays on for a minimum time, so it cannot flicker.
    if (view.tick % ap.conditionIntervalTicks === 0) {
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        const on = slot.impl.condition(view, slot.cfg, slot.def);
        if (on && !slot.active) {
          slot.active = true;
          slot.activeSince = view.tick;
        } else if (!on && slot.active && view.tick - slot.activeSince >= ap.minActiveTicks) {
          slot.active = false;
        }
      }
    }

    // For each channel, the first active behavior that claims it sets the target.
    const tg = this.targets;
    tg.hasForward = tg.hasLateral = tg.hasHeading = false;
    tg.forward = tg.lateral = tg.heading = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.active) continue;
      const ch = slot.def.channels;
      const f = !tg.hasForward && ch.indexOf('forward') >= 0;
      const l = !tg.hasLateral && ch.indexOf('lateral') >= 0;
      const h = !tg.hasHeading && ch.indexOf('heading') >= 0;
      if (!f && !l && !h) continue;
      slot.impl.apply(view, slot.cfg, slot.def, tg, f, l, h);
      if (f) tg.hasForward = true;
      if (l) tg.hasLateral = true;
      if (h) tg.hasHeading = true;
    }

    // Desired force in lane space. An unclaimed axis asks for no force: it coasts.
    // Forward is -y, so a forward speed target is a target on -vy.
    const fwx = tg.hasLateral ? ship.mass * ap.forceGain * (tg.lateral - ship.vx) : 0;
    const fwy = tg.hasForward ? ship.mass * ap.forceGain * (-tg.forward - ship.vy) : 0;
    // Rotate into the ship frame (R transpose).
    const fx = ship.cos * fwx + ship.sin * fwy;
    const fy = -ship.sin * fwx + ship.cos * fwy;
    // An unclaimed heading holds straight down the lane (target 0).
    const torque = ship.inertia
      * (ap.headingGain * wrapAngle(tg.heading - ship.theta) - ap.headingDamping * ship.omega);

    refreshFuelAvail(ship);
    allocate(ship, fx, fy, torque, k.gyroTorque, ap.torqueWeight, ap.allocatorPasses, ap.gyroReluctance);
  }
}

/**
 * Picks throttles in [0,1] (and a gyro command in [-1,1]) that minimize
 *   (Fx - fx)^2 + (Fy - fy)^2 + torqueWeight * (T - torque)^2
 * where F and T are what the thrusters deliver. Coordinate descent in part-id
 * order with the gyro last, warm-started from last tick's throttles.
 * gyroReluctance adds a small ridge penalty on the gyro command.
 */
export function allocate(
  ship: Ship, fx: number, fy: number, torque: number,
  gyroTorque: number, torqueWeight: number, passes: number, gyroReluctance = 0,
): void {
  const n = ship.nThr;
  // Residual = desired - delivered by the current throttles.
  let rx = fx;
  let ry = fy;
  let rt = torque - ship.gyro * gyroTorque;
  for (let t = 0; t < n; t++) {
    if (!usable(ship, t)) {
      ship.thrThrottle[t] = 0;
      continue;
    }
    const th = ship.thrThrottle[t];
    if (th === 0) continue;
    const ax = ship.thrMax[t] * ship.thrFx[t];
    const ay = ship.thrMax[t] * ship.thrFy[t];
    const at = (ship.thrCx[t] - ship.comX) * ay - (ship.thrCy[t] - ship.comY) * ax;
    rx -= th * ax;
    ry -= th * ay;
    rt -= th * at;
  }

  for (let pass = 0; pass < passes; pass++) {
    for (let t = 0; t < n; t++) {
      if (!usable(ship, t)) continue;
      const ax = ship.thrMax[t] * ship.thrFx[t];
      const ay = ship.thrMax[t] * ship.thrFy[t];
      const at = (ship.thrCx[t] - ship.comX) * ay - (ship.thrCy[t] - ship.comY) * ax;
      const denom = ax * ax + ay * ay + torqueWeight * at * at;
      if (denom <= 0) continue;
      const old = ship.thrThrottle[t];
      let next = old + (ax * rx + ay * ry + torqueWeight * at * rt) / denom;
      next = next < 0 ? 0 : next > 1 ? 1 : next;
      const d = next - old;
      if (d !== 0) {
        ship.thrThrottle[t] = next;
        rx -= d * ax;
        ry -= d * ay;
        rt -= d * at;
      }
    }
    if (gyroTorque > 0) {
      // Differential thrust and the gyro can cancel each other at no cost to
      // the objective. The reluctance term breaks that tie toward an idle gyro,
      // which keeps its full authority in reserve for the next impact.
      let next = (ship.gyro + rt / gyroTorque) / (1 + gyroReluctance);
      next = next < -1 ? -1 : next > 1 ? 1 : next;
      rt -= (next - ship.gyro) * gyroTorque;
      ship.gyro = next;
    }
  }
}

function usable(ship: Ship, t: number): boolean {
  const p = ship.thrPart[t];
  const net = ship.partNet[p];
  return ship.partAlive[p] === 1 && net >= 0 && ship.netAvail[net] > 0;
}
