/**
 * DragSailMesh - the look of a drag sail on a big piece that was let go (DECISIONS §33 row 16).
 *
 * owner 2026-10-27: a real drag sail, "like real ones": a thin shiny film held flat by four stiff poles. A small deployer box is bolted
 * to the piece's -Y face (the stage's engine end), four thin carbon poles run from the box to the corners of a square, and a thin
 * aluminised film fills four triangles between the poles (25 m2 = `Constants.BIG_PIECES.SAIL.areaM2`, HPS ADEO-L class; drawn area =
 * the physics area). The film plane is perpendicular to the piece's Y axis, just beyond the box; nothing joins it to the stage's centre.
 * Built in METRES and scaled to the scene by `DebrisField`'s own LOD ratio (`_lodScale`: 0 when the piece is too far to draw). It turns
 * with the piece (the same tumble quaternion); a removed or dead piece takes its sail away on the next `sync`.
 *
 * `DebrisField.attachSail(d)` makes one (lazily creates the set); `DebrisField.update` calls `sync` (the draw hook: ONE line).
 * Nothing here touches game state; with no document / WebGL the objects still build (three.js scene graph only).
 *
 * MEASURED (node probe over `DebrisWireframe.getGeometry('rocketBody')` vertices, x `sizeMeter`): the SL-14 stage's furthest -Y point
 * is the engine bell's rim at -0.5 x sizeMeter (r 0.423); the throat cone inside the bell ends 0.029 x sizeMeter short of it, so a box that
 * touches the rim and a film beyond the box clear every vertex (pinned by test-DragSail.js T1 and T4). ESTIMATES (the owner's eyes
 * still to judge): the box size (0.6 x 0.35 x 0.6 m, ADEO-L class), the pole diameter (5 cm), the 3 cm sag, the film's gloss and the pole
 * colour. `d._meltK` shortens a piece along Y and is ignored here (a known limit: the box then floats a little).
 * @module entities/DragSailMesh
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';

const METRE_SCENE = Constants.SCENE_SCALE / 1000;      // 1 m in scene units (DebrisField's own METRE_SCENE)

/** Deployer box, metres (ESTIMATE, ADEO-L class): width/depth (X, Z) and height (Y, the way the sail unrolls). */
export const SAIL_BOX_M = Object.freeze({ w: 0.6, h: 0.35, d: 0.6 });
/** Pole diameter, metres (ESTIMATE; ADEO-class booms are a few cm, 5 cm reads at 9 m). */
export const SAIL_POLE_DIAM_M = 0.05;
/** How far the middle of each film edge sags toward the piece, metres (ESTIMATE; a look, adds under 0.01 % area). */
export const SAIL_SAG_M = 0.03;

/** @returns {number} the sail's side in metres (the square root of its area). */
export function sailSideM() { return Math.sqrt(Constants.BIG_PIECES.SAIL.areaM2); }

const _minYCache = new WeakMap();
/** The lowest vertex y of a piece's mesh, in mesh units (cached per geometry). @param {THREE.BufferGeometry} geo @returns {number} */
function meshMinY(geo) {
  let v = _minYCache.get(geo);
  if (v === undefined) {
    const p = geo.attributes && geo.attributes.position;
    v = Infinity;
    if (p) for (let i = 0; i < p.count; i++) v = Math.min(v, p.getY(i));
    if (!Number.isFinite(v)) v = -0.5;
    _minYCache.set(geo, v);
  }
  return v;
}

/**
 * Where a piece's furthest point along -Y is, in metres from its centre along local Y (negative): the lowest vertex of its real mesh x its
 * size (for the SL-14 stage that is the engine bell's rim, which is also the bounding-box end). A piece with no known type falls back to
 * half its size.
 * @param {{type?: string, id?: number, sizeMeter?: number}} d @returns {number}
 */
export function sailMountYM(d) {
  const size = (d && d.sizeMeter > 0) ? d.sizeMeter : 5;
  if (!d || !d.type || d.isBag === true) return -0.5 * size;   // a scoop bag is a ball: half its diameter (as DebrisField.trueReachM), whatever type its heaviest member has
  const geo = DebrisWireframe.getGeometry(d.type, d.id);
  const y = meshMinY(geo);
  return (Number.isFinite(y) ? y : -0.5) * size;
}

/**
 * One sail, in metres, in the piece's frame: the deployer box sits against the piece's -Y face at y = `endYM`, the film plane is just beyond
 * the box, four poles run along the film's diagonals from the box to the corners, and four film triangles fill between the poles.
 * @param {number} [sideM] film side (the film's area is sideM^2)
 * @param {number} [endYM] y of the piece's -Y face in metres (negative; default -2.5 = half of a 5 m piece)
 * @returns {THREE.Group}
 */
export function buildSailMesh(sideM = sailSideM(), endYM = -2.5) {
  const g = new THREE.Group();
  g.name = 'DragSail';
  const h = sideM / 2;
  const yPlane = endYM - SAIL_BOX_M.h;                  // the film plane: beyond the box, on the far side from the piece
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(SAIL_BOX_M.w, SAIL_BOX_M.h, SAIL_BOX_M.d),
    new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.6, roughness: 0.5 }),
  );
  box.name = 'DragSailBox';
  box.position.set(0, endYM - SAIL_BOX_M.h / 2, 0);
  g.add(box);

  // the four corners, on the diagonals (a square seen face-on); each pole is half the film diagonal long
  const corners = [[h, h], [-h, h], [-h, -h], [h, -h]].map(([x, z]) => new THREE.Vector3(x, yPlane, z));
  const up = new THREE.Vector3(0, 1, 0);
  const centre = new THREE.Vector3(0, yPlane, 0);
  corners.forEach((c, i) => {
    const len = c.distanceTo(centre);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(SAIL_POLE_DIAM_M / 2, SAIL_POLE_DIAM_M / 2, len, 8), new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.3, roughness: 0.6 }));
    pole.name = 'DragSailBoom';
    pole.position.copy(centre).add(c).multiplyScalar(0.5);
    pole.quaternion.setFromUnitVectors(up, c.clone().sub(centre).normalize());
    pole.userData.lengthM = len;
    g.add(pole);
  });

  // the film: per quarter, centre -> corner A -> edge middle (sagged toward the piece, +Y) -> corner B: two triangles
  const v = [];
  const tri = (a, b, c) => v.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const m = a.clone().add(b).multiplyScalar(0.5); m.y += SAIL_SAG_M;
    tri(centre, a, m); tri(centre, m, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  const film = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xdfe5ec, metalness: 0.95, roughness: 0.15, emissive: 0x1c2228, side: THREE.DoubleSide }),
  );
  film.name = 'DragSailFilm';
  g.add(film);
  g.userData = { sideM, areaM2: sideM * sideM, endYM, yPlane };
  return g;
}

/** The sails of one DebrisField: one group per piece. */
export class DragSailSet {
  /** @param {THREE.Object3D} parent where the sails go (the field's own group, so they share its floating origin) */
  constructor(parent) {
    this._parent = parent;
    /** @type {Map<number|string, {d: object, group: THREE.Group}>} */
    this._rec = new Map();
    this._quat = new THREE.Quaternion();
  }

  get size() { return this._rec.size; }
  has(id) { return this._rec.has(id); }

  /** The group drawn for piece `id`, or null. */
  groupOf(id) { const r = this._rec.get(id); return r ? r.group : null; }

  /** @param {object} d the field's own body @returns {boolean} false when it already has one (or has no id) */
  add(d) {
    if (!d || d.id == null || this._rec.has(d.id)) return false;
    const group = buildSailMesh(sailSideM(), sailMountYM(d));
    group.visible = false;                             // shown by the first sync that has a position
    if (this._parent && typeof this._parent.add === 'function') this._parent.add(group);
    this._rec.set(d.id, { d, group });
    return true;
  }

  remove(id) {
    const r = this._rec.get(id);
    if (!r) return false;
    this._rec.delete(id);
    if (r.group.parent) r.group.parent.remove(r.group);
    r.group.traverse((o) => {
      if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
      if (o.material && typeof o.material.dispose === 'function') o.material.dispose();
    });
    return true;
  }

  /**
   * The draw hook (`DebrisField.update`, once a frame, only while a sail exists): each sail goes to its piece's scene position (less the
   * floating origin), turns with the piece's tumble and scales with its LOD; a piece that is gone, no longer carries the sail or is too
   * far to draw (`_lodScale` 0) loses it (or hides it).
   * @param {{x:number,y:number,z:number}|null} [origin] the floating origin to subtract (null / undefined: none)
   * @param {((d: object) => boolean)|null} [hiddenFn] true = the piece's carrier is hidden, so its sail is too (a held catch goes with the mother)
   */
  sync(origin, hiddenFn = null) {
    for (const [id, r] of [...this._rec]) {
      const d = r.d;
      if (!d || !d.alive || d._sail !== true) { this.remove(id); continue; }
      const sp = d._scenePosition;
      if (!sp || !(d._lodScale > 0) || (hiddenFn && hiddenFn(d))) { r.group.visible = false; continue; }
      const ox = origin ? origin.x : 0, oy = origin ? origin.y : 0, oz = origin ? origin.z : 0;
      r.group.position.set(sp.x - ox, sp.y - oy, sp.z - oz);
      if (d.tumbleAxis) r.group.quaternion.copy(this._quat.setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0));
      const lod = d.sceneSize > 0 ? d._lodScale / d.sceneSize : 1;
      r.group.scale.setScalar(METRE_SCENE * lod);
      r.group.visible = true;
    }
  }

  dispose() { for (const id of [...this._rec.keys()]) this.remove(id); }
}
