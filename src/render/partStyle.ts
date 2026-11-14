// Placeholder look for parts, shared by the shipyard and the run view: flat
// coloured blocks with a glyph that shows which way the part works. Drawn in
// grid units, so the caller sets up a transform where one cell is 1 x 1.

import type { PartDef, PartKind, Rot } from '../sim';

export const KIND_COLOR: Record<PartKind, string> = {
  tile: '#3a4252', core: '#e0b84a', belt: '#7d8794', inserter: '#9aa7b8', collector: '#4fb3a5',
  machine: '#8a6fd1', storage: '#6b7f99', tank: '#3f8fd9', pipe: '#2f6ea8', thruster: '#d9703f',
  computer: '#5fd97a', turret: '#d94f5c', armor: '#59616f', generator: '#d9c23f', shield: '#4fd0e0',
};

/** Short labels for the shipyard, where cells are big enough for text. */
export const PART_LABEL: Record<string, string> = {
  core: 'CORE', belt: '', inserter: '', collector: '', crusher: 'CRU', smelter: 'SME', fabricator: 'FAB',
  storage: 'STO', fuel_tank: 'FUEL', fuel_pipe: '', thruster: '', computer_mk1: 'CPU', autocannon: '',
  armor: 'ARM', chem_plant: 'CHEM', flak_turret: 'FLAK', computer_mk2: 'CPU2', missile_launcher: 'MSL',
  computer_mk3: 'CPU3', alloy_furnace: 'ALLOY', railgun: 'RAIL', alloy_armor: 'AARM', heavy_thruster: '',
  generator: 'GEN', laser: 'LASR', shield_projector: 'SHLD', computer_mk4: 'CPU4',
};

const DARK = '#0b0e14';

/**
 * Draws one part's footprint at (x,y) with size (w,h), already rotated.
 * alpha fades damaged parts in the run view.
 */
export function drawPart(
  ctx: CanvasRenderingContext2D, def: PartDef, x: number, y: number, w: number, h: number, rot: Rot, alpha = 1,
): void {
  const inset = def.kind === 'pipe' ? 0.3 : def.kind === 'belt' ? 0.06 : 0.08;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = KIND_COLOR[def.kind];
  ctx.fillRect(x + inset, y + inset, w - 2 * inset, h - 2 * inset);

  // Direction glyphs, drawn in a frame centred on the part with "forward" up.
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rot * Math.PI) / 180);
  const fw = rot === 90 || rot === 270 ? h : w; // footprint size in the unrotated frame
  const fh = rot === 90 || rot === 270 ? w : h;
  ctx.fillStyle = DARK;
  ctx.strokeStyle = DARK;
  ctx.lineWidth = 0.1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (def.kind) {
    case 'belt': {
      // Chevron pointing the way items move.
      ctx.beginPath();
      ctx.moveTo(-0.25, 0.12);
      ctx.lineTo(0, -0.15);
      ctx.lineTo(0.25, 0.12);
      ctx.stroke();
      break;
    }
    case 'inserter': {
      // Takes from behind (dot), drops in front (arrow).
      ctx.beginPath();
      ctx.arc(0, 0.25, 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, 0.2);
      ctx.lineTo(0, -0.28);
      ctx.moveTo(-0.17, -0.12);
      ctx.lineTo(0, -0.3);
      ctx.lineTo(0.17, -0.12);
      ctx.stroke();
      break;
    }
    case 'thruster': {
      // Nozzle bell at the facing end; the ship is pushed the other way.
      const top = -fh / 2 + 0.08;
      ctx.beginPath();
      ctx.moveTo(-fw / 2 + 0.12, top);
      ctx.lineTo(fw / 2 - 0.12, top);
      ctx.lineTo(fw / 4, top + 0.5);
      ctx.lineTo(-fw / 4, top + 0.5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'turret': {
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(fw, fh) * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 0.16;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -fh / 2 + 0.15);
      ctx.stroke();
      break;
    }
    case 'collector': {
      ctx.lineWidth = 0.08;
      for (const r of [0.25, 0.55]) {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}
