// Loose chunks and salvage drifting in the lane until a collector takes them.

export class Loose {
  readonly cap: number;
  high = 0;
  live = 0;
  readonly alive: Uint8Array;
  readonly item: Int8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly prevX: Float64Array;
  readonly prevY: Float64Array;
  /** Creation order, to find the oldest. */
  readonly seq: Int32Array;
  private nextSeq = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.item = new Int8Array(cap);
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.vx = new Float64Array(cap);
    this.vy = new Float64Array(cap);
    this.prevX = new Float64Array(cap);
    this.prevY = new Float64Array(cap);
    this.seq = new Int32Array(cap);
  }

  /** Takes the lowest free slot. When the pool is full, the oldest despawns. */
  add(item: number, x: number, y: number, vx: number, vy: number): void {
    let i = 0;
    if (this.live >= this.cap) {
      for (let j = 1; j < this.cap; j++) if (this.seq[j] < this.seq[i]) i = j;
      this.live--;
    } else {
      while (i < this.high && this.alive[i]) i++;
      if (i === this.high) this.high++;
    }
    this.alive[i] = 1;
    this.item[i] = item;
    this.x[i] = this.prevX[i] = x;
    this.y[i] = this.prevY[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.seq[i] = this.nextSeq++;
    this.live++;
  }

  remove(i: number): void {
    this.alive[i] = 0;
    this.live--;
    while (this.high > 0 && !this.alive[this.high - 1]) this.high--;
  }
}
