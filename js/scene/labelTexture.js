/**
 * Shared canvas -> CanvasTexture helper for in-world text labels (SunLight planet/
 * constellation labels, MotherCallouts cards) (@module scene/labelTexture).
 *
 * Crispness recipe: 1024×256 canvas, 700-weight Helvetica, NO shadow blur (it bled
 * into glyph edges at pixelRatio 1.5 with SMAA off), linear-mipmap + anisotropy + sRGB.
 */

import * as THREE from 'three';
import { mono, ui, MONO_ADVANCE_EM } from '../core/Typeface.js';

/**
 * Billboard text-label texture; `text` is drawn centred, single line.
 * @param {object} [opts]
 * @param {number} [opts.fontPx=112]   canvas px (canvas height is 256)
 * @param {boolean} [opts.pill=false]  dark rounded chip behind the text, stroked in `color`
 */
export function createLabelTexture(text, { color = '#ffffff', fontPx = 112, pill = false } = {}) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.font = `700 ${fontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (pill) {
    const tw = Math.min(ctx.measureText(text).width, c.width - 40);
    const padX = 36, padY = 30;
    const w = tw + padX * 2;
    const h = fontPx + padY * 2;
    const x = (c.width - w) / 2;
    const y = (c.height - h) / 2;
    const r = h * 0.32;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(3, 8, 16, 0.74)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  // Dark halo keeps text legible when the pill is absent or semi-transparent.
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, fontPx * 0.06);
  ctx.strokeStyle = 'rgba(2, 6, 12, 0.85)';
  ctx.strokeText(text, 512, 128);

  ctx.fillStyle = color;
  ctx.globalAlpha = 1.0;
  ctx.fillText(text, 512, 128);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4; // Three.js clamps to renderer max; sharpens at oblique angles
  return tex;
}

// Multi-line inspection card. ONE face for BOTH drawing and measurement so the wrap
// budget can never drift from the draw. Cards use the house mono token via
// Typeface.mono() (B612 Mono 700/400); the codex glyph uses the UI token (the ▸ falls
// through to the next family if B612 lacks it).
const CARD_TITLE_FONT = mono(36, 700);
const CARD_ROW_FONT   = mono(28);
const CARD_GLYPH_FONT = ui(40, 700);

const CARD_W = 640;          // logical canvas width (px, pre-DPR); fits ~22-char titles
const CARD_PAD_TOP = 22;
const CARD_PAD_BOTTOM = 22;
const CARD_TITLE_H = 62;     // title-row block height
const CARD_ROW_H = 44;       // each data-row block height
const CARD_TAB_W = 2;        // px accent line
const CARD_PAD_L = 24;       // content left pad (after tab)
const CARD_PAD_R = 18;       // content right pad

// Logical height of a 0-row card (title block only); total height = this × heightFactor.
const CARD_TITLE_BLOCK_H = CARD_PAD_TOP + CARD_TITLE_H + CARD_PAD_BOTTOM; // 106
// aspect × heightFactor is invariant (= 640/106 ≈ 6.04) for every card, so the
// caller can size/clamp from _sizeFrac alone without reading rec.card.
export const CARD_W_OVER_TITLE_H = CARD_W / CARD_TITLE_BLOCK_H;

/**
 * Word-wrap a hint to the card content width; up to `maxLines` lines, with an
 * ellipsis on the last line when text remains (truncation is never silent).
 * The SINGLE wrap implementation: MotherCallouts pre-wraps with it for its row
 * budget and the card draws the lines verbatim, so budget and draw can't disagree.
 * Falls back to a character-width estimate with no 2d context (headless Node).
 * @returns {string[]} 1..maxLines lines
 */
export function wrapHint(text, maxLines = 2) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const probe = _measureCtx();
  const maxW = _contentWidth();

  if (!probe) {
    // No 2D context: B612 Mono MONO_ADVANCE_EM at the 28 px row size (~18.2 px/char).
    const perLine = Math.max(1, Math.floor(maxW / (28 * MONO_ADVANCE_EM)));
    const out = [];
    let cur = '';
    for (const word of words) {
      const next = cur ? cur + ' ' + word : word;
      if (next.length <= perLine) { cur = next; continue; }
      if (out.length >= maxLines - 1) {
        out.push((cur.length > perLine - 1 ? cur.slice(0, perLine - 1) : cur) + '\u2026');
        return out;
      }
      out.push(cur); cur = word;
    }
    if (cur) out.push(cur);
    return out.slice(0, maxLines);
  }

  const spaceW = probe.measureText(' ').width;
  const out = [];
  let lineW = 0;
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    const w = probe.measureText(word).width;
    if (out.length === 0 && lineW === 0) {
      out.push(word); lineW = w; continue;
    }
    if (lineW + spaceW + w <= maxW) {
      out[out.length - 1] += ' ' + word; lineW += spaceW + w;
    } else {
      if (out.length >= maxLines) {
        let last = out[out.length - 1];
        while (last.length > 1 && probe.measureText(last + '\u2026').width > maxW) {
          last = last.slice(0, -1);
        }
        out[out.length - 1] = last + '\u2026';
        return out;
      }
      out.push(word); lineW = w;
    }
  }
  return out;
}

// Shared 2d context for text measurement only. The font is set on EVERY call, not at
// creation: a 2D context resolves its face when `.font` is assigned, so a probe made
// before the B612 faces settled would keep measuring the fallback.
let _probe = null;
function _measureCtx() {
  if (!_probe) {
    const c = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    _probe = c ? c.getContext('2d') : null;
  }
  if (_probe) _probe.font = CARD_ROW_FONT;
  return _probe;
}
function _contentWidth() {
  const inset = 3;
  const contentL = inset + CARD_TAB_W + CARD_PAD_L;
  const contentR = CARD_W - CARD_PAD_R;
  return contentR - contentL;
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Multi-line inspection card texture for a part callout: dark chip, system-hue
 * accent line, title row (risk dot + title, codex glyph right-aligned when linked),
 * up to 6 dimmer data rows. Canvas height varies with row count.
 *
 * Hover is NOT baked into the texture: it is a material-level effect on the
 * sprite, which keeps label texture memory at ~37 MB instead of doubling it.
 *
 * @param {object} spec
 * @param {Array<{text:string,dim?:boolean,color?:string}>} [spec.rows]
 *   up to 6 rows, pre-wrapped by the caller (see wrapHint); `color` overrides the fill
 * @param {string} [spec.riskColor]  risk dot colour (omit -> no dot)
 * @param {string} [spec.systemColor='#7fd4e8']  left accent line + accents
 * @param {string} [spec.inkColor='#dfeef5']  row text colour (dim=false)
 * @param {string} [spec.inkDimColor='#9fb8c4']  row text colour (dim=true)
 * @param {'linked'|'locked'|null} [spec.codex=null]
 * @returns {{ texture: THREE.CanvasTexture, heightFactor: number }}
 *   `heightFactor` = logicalH / 106 (106 = 0-row height); width follows from the
 *   exported CARD_W_OVER_TITLE_H invariant, so no aspect is returned.
 */
export function createCardTexture(spec = {}) {
  // Defaults mirror Constants.CALLOUTS.INK / INK_DIM / ACCENT; no Constants import
  // (leaf helper), so MotherCallouts is the source of truth and passes explicit values.
  const {
    title = '',
    titleColor = '#dfeef5',
    rows = [],
    riskColor = null,
    systemColor = '#7fd4e8',
    inkColor = '#dfeef5',
    inkDimColor = '#9fb8c4',
    codex = null,
  } = spec;

  // Rows arrive pre-wrapped (wrapHint) and are drawn verbatim.
  const nRows = Math.min(rows.length, 6);
  const logicalW = CARD_W;
  const logicalH = CARD_PAD_TOP + CARD_TITLE_H + nRows * CARD_ROW_H + CARD_PAD_BOTTOM;
  const heightFactor = logicalH / CARD_TITLE_BLOCK_H;

  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio)
    ? Math.min(window.devicePixelRatio, 2) : 1;

  const c = document.createElement('canvas');
  c.width = Math.round(logicalW * dpr);
  c.height = Math.round(logicalH * dpr);
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);

  // Chip background: alpha 0.75 so cards don't wash out over the bright solar wing / radar dome.
  const inset = 3;
  ctx.fillStyle = 'rgba(4, 12, 20, 0.75)';
  ctx.fillRect(inset, inset, logicalW - inset * 2, logicalH - inset * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = systemColor;
  ctx.globalAlpha = 0.7;
  ctx.strokeRect(inset, inset, logicalW - inset * 2, logicalH - inset * 2);
  ctx.globalAlpha = 1.0;

  // Corner ticks
  const tick = 10;
  ctx.lineWidth = 2;
  ctx.strokeStyle = systemColor;
  ctx.globalAlpha = 1.0;
  // top-left
  ctx.beginPath(); ctx.moveTo(inset, inset + tick); ctx.lineTo(inset, inset); ctx.lineTo(inset + tick, inset); ctx.stroke();
  // top-right
  ctx.beginPath(); ctx.moveTo(logicalW - inset - tick, inset); ctx.lineTo(logicalW - inset, inset); ctx.lineTo(logicalW - inset, inset + tick); ctx.stroke();
  // bottom-left
  ctx.beginPath(); ctx.moveTo(inset, logicalH - inset - tick); ctx.lineTo(inset, logicalH - inset); ctx.lineTo(inset + tick, logicalH - inset); ctx.stroke();
  // bottom-right
  ctx.beginPath(); ctx.moveTo(logicalW - inset - tick, logicalH - inset); ctx.lineTo(logicalW - inset, logicalH - inset); ctx.lineTo(logicalW - inset, logicalH - inset - tick); ctx.stroke();

  ctx.fillStyle = systemColor;
  ctx.fillRect(inset, inset, CARD_TAB_W, logicalH - inset * 2);

  const contentL = inset + CARD_TAB_W + CARD_PAD_L;
  const contentR = logicalW - CARD_PAD_R;

  const titleCY = CARD_PAD_TOP + CARD_TITLE_H / 2;
  let textL = contentL;

  if (riskColor) {
    const r = 9;
    ctx.beginPath();
    ctx.arc(contentL + r, titleCY, r, 0, Math.PI * 2);
    ctx.fillStyle = riskColor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    textL = contentL + r * 2 + 14;
  }

  // Codex glyph, right-aligned. Locked = ▸ plus a muted vector padlock (reads "details
  // locked", matching CodexViewerUI). Drawn as primitives, not 🔒: colour-emoji fonts
  // ignore fillStyle and render full-colour gold.
  let glyphL = contentR;
  if (codex) {
    const isLocked = codex === 'locked';
    const linkGlyph = '\u25B8'; // ▸
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    if (isLocked) {
      ctx.font = CARD_GLYPH_FONT;
      ctx.fillStyle = systemColor;
      ctx.globalAlpha = 0.9;
      const linkW = ctx.measureText(linkGlyph).width;
      const lockCx = contentR - 8;            // padlock centre-x (right-aligned)
      const linkR = lockCx - 16;              // ▸ right edge sits left of the lock
      ctx.fillText(linkGlyph, linkR, titleCY);
      ctx.globalAlpha = 1.0;
      _drawPadlock(ctx, lockCx, titleCY, '#667');
      glyphL = linkR - linkW - 12;
    } else {
      ctx.font = CARD_GLYPH_FONT;
      ctx.fillStyle = systemColor;
      ctx.globalAlpha = 0.9;
      ctx.fillText(linkGlyph, contentR, titleCY);
      ctx.globalAlpha = 1.0;
      const gw = ctx.measureText(linkGlyph).width;
      glyphL = contentR - gw - 12;
    }
  }

  // Title, clipped before the glyph. Letter-spacing affects measureText: set it BEFORE
  // the truncation loop and reset to '0px' before drawing rows.
  ctx.font = CARD_TITLE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
  const availW = glyphL - textL;
  let titleTxt = title;
  while (titleTxt.length > 1 && ctx.measureText(titleTxt).width > availW) {
    titleTxt = titleTxt.slice(0, -1);
  }
  if (titleTxt !== title && titleTxt.length > 1) titleTxt = titleTxt.slice(0, -1) + '\u2026';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(2, 6, 12, 0.85)';
  ctx.strokeText(titleTxt, textL, titleCY);
  ctx.fillStyle = titleColor;
  ctx.fillText(titleTxt, textL, titleCY);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  ctx.font = CARD_ROW_FONT;
  for (let i = 0; i < nRows; i++) {
    const row = rows[i];
    const cy = CARD_PAD_TOP + CARD_TITLE_H + CARD_ROW_H * i + CARD_ROW_H / 2;
    let rowTxt = row.text || '';
    const maxW = contentR - contentL;
    while (rowTxt.length > 1 && ctx.measureText(rowTxt).width > maxW) {
      rowTxt = rowTxt.slice(0, -1);
    }
    if (rowTxt !== (row.text || '') && rowTxt.length > 1) rowTxt = rowTxt.slice(0, -1) + '\u2026';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(2, 6, 12, 0.8)';
    ctx.strokeText(rowTxt, contentL, cy);
    // Precedence: custom color, then dim flag, then default bright.
    if (row.color) {
      ctx.fillStyle = row.color;
    } else {
      ctx.fillStyle = row.dim === false ? inkColor : inkDimColor;
    }
    ctx.fillText(rowTxt, contentL, cy);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;

  return { texture: tex, heightFactor };
}

/** Small vector padlock (body + shackle) centred on (cx, cy); see the codex glyph note. */
function _drawPadlock(ctx, cx, cy, color) {
  const w = 12, h = 9, r = 2;
  const x = cx - w / 2, y = cy - h / 2 + 2;
  ctx.beginPath();
  ctx.arc(cx, y, w * 0.32, Math.PI, 0);
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  _roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}
