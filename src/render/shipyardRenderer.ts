// Draws the shipyard grid: tiles, parts, the placement ghost, the symmetry
// line, the ship's size against the lane limit and its centre of mass. Reads
// the editor's design and never changes it. Redraws only when asked.

import type { DesignEditor, ShipStats } from '../game';
import { MAX_GRID, nozzleCells, partDefIndex, rotH, rotW } from '../sim';
import type { Content, PartInstance } from '../sim';
import { drawPart, KIND_COLOR, PART_LABEL } from './partStyle';

export interface Ghost {
  parts: PartInstance[];
  /** Bare tiles a path or tile placement would add. */
  tiles: [number, number][];
  valid: boolean;
}

export interface YardView {
  ghost: Ghost | null;
  /** Part being carried by a move, drawn faded where it was. */
  lifted: number;
  /** Part shown in the info sheet. */
  selected: number;
  laneMax: [number, number];
  stats: ShipStats | null;
}

export class ShipyardRenderer {
  /** Pixels per cell, and the screen position of workspace cell (0,0). */
  scale = 32;
  ox = 0;
  oy = 0;
  w = 0;
  h = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly content: Content) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Frames a region of the workspace, in cells, with some margin. */
  frame(x: number, y: number, w: number, h: number): void {
    const margin = 2.5;
    this.scale = Math.max(8, Math.min(this.w / (w + 2 * margin), this.h / (h + 2 * margin), 64));
    this.ox = this.w / 2 - (x + w / 2) * this.scale;
    this.oy = this.h / 2 - (y + h / 2) * this.scale;
  }

  /** Screen point (CSS px relative to the canvas) to workspace coordinates. */
  toGrid(px: number, py: number): [number, number] {
    return [(px - this.ox) / this.scale, (py - this.oy) / this.scale];
  }

  /** Zooms by a factor about a screen point. */
  zoomAt(px: number, py: number, factor: number): void {
    const next = Math.max(8, Math.min(96, this.scale * factor));
    const [gx, gy] = this.toGrid(px, py);
    this.scale = next;
    this.ox = px - gx * next;
    this.oy = py - gy * next;
  }

  draw(ed: DesignEditor, view: YardView): void {
    const { ctx, scale: s, content } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(s, s);
    const px = 1 / s; // one screen pixel in grid units

    // Build area grid, only the visible part.
    const x0 = Math.max(0, Math.floor(-this.ox / s));
    const y0 = Math.max(0, Math.floor(-this.oy / s));
    const x1 = Math.min(MAX_GRID, Math.ceil((this.w - this.ox) / s));
    const y1 = Math.min(MAX_GRID, Math.ceil((this.h - this.oy) / s));
    ctx.strokeStyle = '#161c28';
    ctx.lineWidth = px;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = y0; y <= y1; y++) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();

    const d = ed.design;
    const stats = view.stats;

    // Lane size limit: a dashed frame from the ship's top edge, centred across it,
    // and the ship's own box in red when it does not fit.
    if (stats && d.tiles.length) {
      const [mw, mh] = view.laneMax;
      const fits = stats.width <= mw && stats.height <= mh;
      const fx = Math.round(stats.minX + stats.width / 2 - mw / 2);
      const fy = stats.minY;
      ctx.setLineDash([4 * px, 4 * px]);
      ctx.strokeStyle = '#3d4a63';
      ctx.lineWidth = 1.5 * px;
      ctx.strokeRect(fx, fy, mw, mh);
      ctx.setLineDash([]);
      if (!fits) {
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2 * px;
        ctx.strokeRect(stats.minX, stats.minY, stats.width, stats.height);
      }
    }

    // Thruster exhaust zones: cells that must stay empty.
    ctx.fillStyle = '#d9703f22';
    for (const p of d.parts) {
      const di = partDefIndex(content, p.type);
      if (content.parts[di]?.kind !== 'thruster') continue;
      for (const [x, y] of nozzleCells(content.parts[di], p)) ctx.fillRect(x, y, 1, 1);
    }

    // Tiles.
    ctx.fillStyle = KIND_COLOR.tile;
    for (const [x, y] of d.tiles) ctx.fillRect(x + 0.04, y + 0.04, 0.92, 0.92);

    // Parts.
    d.parts.forEach((p, i) => {
      const def = content.parts[partDefIndex(content, p.type)];
      drawPart(ctx, def, p.x, p.y, rotW(def, p.rot), rotH(def, p.rot), p.rot, i === view.lifted ? 0.3 : 1);
    });

    // Selection outline.
    if (view.selected >= 0 && view.selected < d.parts.length) {
      const f = ed.footprint(d.parts[view.selected]);
      ctx.strokeStyle = '#ffd84a';
      ctx.lineWidth = 3 * px;
      ctx.strokeRect(f.x, f.y, f.w, f.h);
    }

    // Symmetry line through the core's centre.
    const axis2 = ed.symmetry ? ed.axis2() : null;
    if (axis2 !== null) {
      ctx.strokeStyle = '#5b8fd6';
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.beginPath();
      ctx.moveTo(axis2 / 2, y0);
      ctx.lineTo(axis2 / 2, y1);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Ghost.
    const g = view.ghost;
    if (g) {
      const tint = g.valid ? '#7dffa0' : '#ff6b6b';
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = tint;
      for (const [x, y] of g.tiles) ctx.fillRect(x, y, 1, 1);
      ctx.globalAlpha = 1;
      for (const p of g.parts) {
        const def = content.parts[partDefIndex(content, p.type)];
        const w = rotW(def, p.rot);
        const h = rotH(def, p.rot);
        drawPart(ctx, def, p.x, p.y, w, h, p.rot, 0.55);
        ctx.strokeStyle = tint;
        ctx.lineWidth = 2.5 * px;
        ctx.strokeRect(p.x, p.y, w, h);
        if (def.kind === 'thruster') {
          ctx.fillStyle = g.valid ? '#7dffa033' : '#ff6b6b55';
          for (const [x, y] of nozzleCells(def, p)) ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // Centre of mass.
    if (stats && stats.mass > 0) {
      const r = 0.32;
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = '#0b0e14';
      ctx.beginPath();
      ctx.arc(stats.comX, stats.comY, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(stats.comX, stats.comY);
      ctx.arc(stats.comX, stats.comY, r, -Math.PI / 2, 0);
      ctx.lineTo(stats.comX, stats.comY);
      ctx.moveTo(stats.comX, stats.comY);
      ctx.arc(stats.comX, stats.comY, r, Math.PI / 2, Math.PI);
      ctx.fill();
    }
    ctx.restore();

    // Labels in screen space, when cells are big enough to read them.
    if (s >= 18) {
      ctx.fillStyle = '#0b0e14';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.min(13, Math.round(s * 0.36))}px ui-sans-serif, system-ui, sans-serif`;
      d.parts.forEach((p, i) => {
        const label = PART_LABEL[p.type];
        if (!label || i === view.lifted) return;
        const f = ed.footprint(p);
        if (f.w * s < label.length * s * 0.24) return;
        ctx.fillText(label, this.ox + (f.x + f.w / 2) * s, this.oy + (f.y + f.h / 2) * s);
      });
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }
}
