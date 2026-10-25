/**
 * DragSailMesh - the look of a drag sail on a big piece that was let go (Nets step 3 slice 5, lane 5d; plan D5; DECISIONS §33 row 16).
 *
 * A flat square of thin silver film, 5 m a side (`Constants.BIG_PIECES.SAIL.areaM2` = 25 m2: HPS ADEO-L class), held out on four booms
 * that run from the piece to the sail's corners. It is built in METRES and scaled to the scene by `DebrisField`'s own LOD ratio, so it
 * shrinks and goes with the piece it hangs on (`_lodScale`: 0 when the piece is too far to draw). It turns with the piece (the same
 * tumble quaternion) and is hidden or removed with it: a removed or dead piece takes its sail away on the next `sync`.
 *
 * `DebrisField.attachSail(d)` makes one (lazily creates the set) and `DebrisField.update` calls `sync` (the draw hook: ONE line). Nothing here
 * touches game state; with no document / WebGL nothing is drawn but the objects still build (three.js scene graph only).
 *
 * UNPROVEN until looked at (owner's eyes): the standoff, the film's opacity and the boom colour are estimates.
 * @module entities/DragSailMesh
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';

const METRE_SCENE = Constants.SCENE_SCALE / 1000;      // 1 m in scene units (DebrisField's own METRE_SCENE)

/** @returns {number} the sail's side in metres (the square root of its area). */
export function sailSideM() { return Math.sqrt(Constants.BIG_PIECES.SAIL.areaM2); }

/**
 * One sail, in metres, centred on the piece: the film sits `standoffM` out along +Z; four booms run from the piece to its corners.
 * @param {number} [sideM] film side @param {number} [standoffM] how far out the film is held
 * @returns {THREE.Group}
 */
export function buildSailMesh(sideM = sailSideM(), standoffM = 2) {
  const g = new THREE.Group();
  g.name = 'DragSail';
  const h = sideM / 2;
  const film = new THREE.Mesh(
    new THREE.PlaneGeometry(sideM, sideM),
    new THREE.MeshStandardMaterial({ color: 0xdfe5ec, metalness: 0.85, roughness: 0.3, emissive: 0x1c2228, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
  );
  film.name = 'DragSailFilm';
  film.position.z = standoffM;
  g.add(film);
  const pts = [];
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) pts.push(0, 0, 0, sx * h, sy * h, standoffM);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const booms = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xa3adb8 }));
  booms.name = 'DragSailBooms';
  g.add(booms);
  g.userData = { sideM, areaM2: sideM * sideM, standoffM };
  return g;
}

/** The sails of one DebrisField: one group per piece, each following its piece. */
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

  /** The group drawn for piece `id` (tests / probes), or null. */
  groupOf(id) { const r = this._rec.get(id); return r ? r.group : null; }

  /** @param {object} d the field's own body @returns {boolean} false when it already has one (or has no id) */
  add(d) {
    if (!d || d.id == null || this._rec.has(d.id)) return false;
    const standoff = Math.max(2, (d.sizeMeter || 0) / 2 + 1);
    const group = buildSailMesh(sailSideM(), standoff);
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
