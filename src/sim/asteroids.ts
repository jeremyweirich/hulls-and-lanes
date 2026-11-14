// Asteroid pool and the lane spawner (spec section 9). The lane is cut into
// slices whose contents depend only on the run seed and the slice number,
// never on when the ship arrives.

import { Rng, seedFor, STREAM_SPAWN } from './rng';
import type { Content, LaneDef, LaneSegment } from './types';

export class Asteroids {
  readonly cap: number;
  /** Slots [0, high) may be alive; iteration is always in slot order. */
  high = 0;
  live = 0;
  readonly alive: Uint8Array;
  readonly size: Int8Array;
  readonly material: Int8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly hp: Float64Array;
  readonly prevX: Float64Array;
  readonly prevY: Float64Array;

  constructor(cap: number) {
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.size = new Int8Array(cap);
    this.material = new Int8Array(cap);
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.vx = new Float64Array(cap);
    this.vy = new Float64Array(cap);
    this.hp = new Float64Array(cap);
    this.prevX = new Float64Array(cap);
    this.prevY = new Float64Array(cap);
  }

  /** Takes the lowest free slot. The caller has checked there is room. */
  add(size: number, material: number, x: number, y: number, vx: number, vy: number, hp: number): number {
    let i = 0;
    while (i < this.high && this.alive[i]) i++;
    if (i === this.high) this.high++;
    this.alive[i] = 1;
    this.size[i] = size;
    this.material[i] = material;
    this.x[i] = this.prevX[i] = x;
    this.y[i] = this.prevY[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.hp[i] = hp;
    this.live++;
    return i;
  }

  remove(i: number): void {
    this.alive[i] = 0;
    this.live--;
    while (this.high > 0 && !this.alive[this.high - 1]) this.high--;
  }
}

export class Spawner {
  nextSlice = 0;
  private readonly rng = new Rng();
  private readonly sliceCount: number;

  constructor(
    private readonly content: Content,
    private readonly lane: LaneDef,
    private readonly seed: number,
  ) {
    this.sliceCount = Math.ceil(lane.length / content.constants.spawn.sliceLength);
  }

  /**
   * Tick order 2: creates every slice that has come within range ahead of the
   * ship. A slice that does not fit under the asteroid cap is deferred whole
   * until there is room.
   */
  step(asteroids: Asteroids, shipDistance: number): void {
    const sp = this.content.constants.spawn;
    while (this.nextSlice < this.sliceCount
      && this.nextSlice * sp.sliceLength < shipDistance + sp.aheadDistance) {
      if (!this.spawnSlice(asteroids, this.nextSlice)) return;
      this.nextSlice++;
    }
  }

  private segmentAt(distance: number): LaneSegment | null {
    for (const seg of this.lane.segments) if (distance < seg.to) return seg;
    return null;
  }

  private spawnSlice(asteroids: Asteroids, slice: number): boolean {
    const sp = this.content.constants.spawn;
    const sizes = this.content.asteroidSizes;
    const start = slice * sp.sliceLength;
    const seg = this.segmentAt(start + sp.sliceLength / 2);
    if (!seg || start < this.lane.clearStart) return true;

    // First pass counts, so a slice is spawned whole or not at all.
    const rng = this.rng;
    rng.seed(seedFor(this.seed, STREAM_SPAWN, slice));
    let need = 0;
    for (let s = 0; s < sizes.length; s++) need += this.drawCount(seg, s);
    if (asteroids.live + need > asteroids.cap) return false;

    // Second pass replays the same draws and places the asteroids.
    rng.seed(seedFor(this.seed, STREAM_SPAWN, slice));
    const counts: number[] = this.counts;
    for (let s = 0; s < sizes.length; s++) counts[s] = this.drawCount(seg, s);
    const half = this.lane.width / 2;
    const mats = this.content.materials;
    let weightSum = 0;
    for (let m = 0; m < mats.length; m++) weightSum += seg.materials[mats[m]] ?? 0;
    for (let s = 0; s < sizes.length; s++) {
      for (let i = 0; i < counts[s]; i++) {
        const x = rng.range(-half, half);
        const dist = start + rng.next() * sp.sliceLength;
        let pick = rng.next() * weightSum;
        let material = 0;
        for (let m = 0; m < mats.length; m++) {
          const w = seg.materials[mats[m]] ?? 0;
          if (w <= 0) continue;
          material = m;
          if (pick < w) break;
          pick -= w;
        }
        const vx = rng.range(-sp.maxLateralDrift, sp.maxLateralDrift);
        const vy = rng.next() * sp.maxApproachDrift;
        asteroids.add(s, material, x, -dist, vx, vy, sizes[s].hp);
      }
    }
    return true;
  }

  private readonly counts: number[] = [];

  /** Density per 100 u becomes a whole count: the fraction is a coin flip. */
  private drawCount(seg: LaneSegment, size: number): number {
    const density = seg.per100u[this.content.asteroidSizes[size].id] ?? 0;
    const expected = density * this.content.constants.spawn.sliceLength / 100;
    const whole = Math.floor(expected);
    return whole + (this.rng.next() < expected - whole ? 1 : 0);
  }
}
