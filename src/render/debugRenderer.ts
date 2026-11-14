// Debug renderer for milestone 1: plain Canvas 2D shapes, no assets. It only
// reads sim state. The camera follows the ship with forward up the screen and
// about 40 u of lane visible ahead (spec section 12).

import type { PartKind, Sim } from '../sim';

const KIND_COLOR: Record<PartKind, string> = {
  tile: '#3a4252', core: '#e0b84a', belt: '#7d8794', inserter: '#9aa7b8', collector: '#4fb3a5',
  machine: '#8a6fd1', storage: '#6b7f99', tank: '#3f8fd9', pipe: '#2f6ea8', thruster: '#d9703f',
  computer: '#5fd97a', turret: '#d94f5c', armor: '#59616f', generator: '#d9c23f', shield: '#4fd0e0',
};
const MATERIAL_COLOR = ['#8d939e', '#5b5148', '#9fc4d9'];

const AHEAD = 40;
/** Share of the view height above the ship. */
const SHIP_AT = 0.74;

export class DebugRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** alpha in [0,1] blends from the previous tick's positions to the current ones. */
  draw(sim: Sim, alpha: number): void {
    const { ctx, w, h } = this;
    const ship = sim.ship;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;

    let dTheta = ship.theta - ship.prevTheta;
    if (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const theta = ship.prevTheta + dTheta * alpha;
    const sx = lerp(ship.prevX, ship.x);
    const sy = lerp(ship.prevY, ship.y);

    const scale = (h * SHIP_AT) / (AHEAD + 4);
    const camX = Math.max(-sim.lane.width / 2, Math.min(sim.lane.width / 2, sx));
    const toX = (x: number) => w / 2 + (x - camX) * scale;
    const toY = (y: number) => h * SHIP_AT + (y - sy) * scale;

    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, w, h);

    // Lane edges, with a tick every 10 u and a label every 100 u.
    const half = sim.lane.width / 2;
    ctx.strokeStyle = '#2c3546';
    ctx.fillStyle = '#566178';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    for (const edge of [-half, half]) {
      ctx.beginPath();
      ctx.moveTo(toX(edge), 0);
      ctx.lineTo(toX(edge), h);
      ctx.stroke();
    }
    const topDist = -sy + (h * SHIP_AT) / scale;
    const bottomDist = -sy - (h * (1 - SHIP_AT)) / scale;
    for (let d = Math.ceil(bottomDist / 10) * 10; d <= topDist; d += 10) {
      if (d < 0 || d > sim.lane.length) continue;
      const y = toY(-d);
      const major = d % 100 === 0;
      for (const edge of [-half, half]) {
        const dir = edge < 0 ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(toX(edge), y);
        ctx.lineTo(toX(edge) + dir * (major ? 12 : 5), y);
        ctx.stroke();
      }
      if (major) ctx.fillText(String(d), toX(-half) + 15, y + 3);
    }
    // Start and finish lines.
    ctx.strokeStyle = '#5fd97a';
    for (const d of [0, sim.lane.length]) {
      ctx.beginPath();
      ctx.moveTo(toX(-half), toY(-d));
      ctx.lineTo(toX(half), toY(-d));
      ctx.stroke();
    }

    // Asteroids: darker as they lose HP.
    const a = sim.asteroids;
    for (let i = 0; i < a.high; i++) {
      if (!a.alive[i]) continue;
      const def = sim.content.asteroidSizes[a.size[i]];
      const x = toX(lerp(a.prevX[i], a.x[i]));
      const y = toY(lerp(a.prevY[i], a.y[i]));
      const r = def.radius * scale;
      if (y < -r || y > h + r) continue;
      ctx.globalAlpha = 0.45 + 0.55 * Math.max(0, a.hp[i] / def.hp);
      ctx.fillStyle = MATERIAL_COLOR[a.material[i]] ?? '#888';
      ctx.beginPath();
      ctx.arc(x, y, Math.max(r, 1.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Ship, drawn in grid space.
    ctx.save();
    ctx.translate(toX(sx), toY(sy));
    ctx.rotate(theta);
    ctx.scale(scale, scale);
    ctx.translate(-ship.comX, -ship.comY);

    for (let y = 0; y < ship.gh; y++) {
      for (let x = 0; x < ship.gw; x++) {
        const c = y * ship.gw + x;
        if (!ship.cellTile[c]) continue;
        const bare = ship.cellPart[c] < 0;
        ctx.fillStyle = bare && ship.cellHp[c] < 100 ? '#4a3a3a' : KIND_COLOR.tile;
        ctx.fillRect(x + 0.02, y + 0.02, 0.96, 0.96);
      }
    }
    for (let p = 0; p < ship.n; p++) {
      if (!ship.partAlive[p]) continue;
      const def = ship.defs[p];
      const hp = ship.partHp[p] / def.hp;
      ctx.fillStyle = KIND_COLOR[def.kind];
      ctx.globalAlpha = 0.35 + 0.65 * hp;
      ctx.fillRect(ship.partX[p] + 0.08, ship.partY[p] + 0.08, ship.partW[p] - 0.16, ship.partH[p] - 0.16);
      ctx.globalAlpha = 1;
      if (hp < 1) {
        ctx.strokeStyle = '#ff5c5c';
        ctx.lineWidth = 0.08;
        ctx.strokeRect(ship.partX[p] + 0.08, ship.partY[p] + 0.08, ship.partW[p] - 0.16, ship.partH[p] - 0.16);
      }
    }

    // Thruster flames: length follows the throttle actually delivered.
    for (let t = 0; t < ship.nThr; t++) {
      const eff = ship.thrEff[t];
      if (eff <= 0.01 || !ship.partAlive[ship.thrPart[t]]) continue;
      const p = ship.thrPart[t];
      const nx = -ship.thrFx[t];
      const ny = -ship.thrFy[t];
      const bx = ship.thrCx[t] + nx * (ship.partW[p] / 2) * Math.abs(nx) + nx * 0 + ny * 0;
      const by = ship.thrCy[t] + ny * (ship.partH[p] / 2) * Math.abs(ny);
      const wide = (nx !== 0 ? ship.partH[p] : ship.partW[p]) * 0.35;
      const len = 0.4 + 1.6 * eff;
      ctx.fillStyle = '#ffb347';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(bx - ny * wide, by + nx * wide);
      ctx.lineTo(bx + ny * wide, by - nx * wide);
      ctx.lineTo(bx + nx * len, by + ny * len);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Center of mass.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.arc(ship.comX, ship.comY, 0.3, 0, Math.PI * 2);
    ctx.moveTo(ship.comX - 0.5, ship.comY);
    ctx.lineTo(ship.comX + 0.5, ship.comY);
    ctx.moveTo(ship.comX, ship.comY - 0.5);
    ctx.lineTo(ship.comX, ship.comY + 0.5);
    ctx.stroke();
    ctx.restore();

    if (sim.outcome !== 'running') {
      const good = sim.outcome === 'success';
      ctx.fillStyle = good ? '#16351fd9' : '#3a1717d9';
      ctx.fillRect(0, h * 0.36, w, 64);
      ctx.fillStyle = good ? '#7dffa0' : '#ff8a8a';
      ctx.textAlign = 'center';
      ctx.font = 'bold 20px ui-monospace, monospace';
      ctx.fillText(good ? 'LANE CLEARED' : 'RUN FAILED', w / 2, h * 0.36 + 28);
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(good ? `${(sim.tick / 30).toFixed(1)} s` : String(sim.cause).replace(/_/g, ' '), w / 2, h * 0.36 + 50);
      ctx.textAlign = 'start';
    }
  }
}
