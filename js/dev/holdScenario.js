/**
 * Dev staging (`?shot=1` only): a daughter docked at home holding a real 3-5 m piece, without a minutes-long real catch.
 * Puts a REAL debris piece on a real daughter's rack through the real dock completion (`ArmUnit._updateDocking` -> `_stowHeldCatch`
 * -> `_pinHeldCatches` -> HOLDING_CATCH), so the hold pose, wing-clear profile and radiator wait run for real afterwards.
 * No net bag is staged (as in the node tests' `w.rack`): the piece is drawn bare, at its real size and attitude.
 * `window.__holdScenario(opts)` (main.js) calls {@link stageHoldScenario}.
 *
 * @module dev/holdScenario
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { DebrisField } from '../entities/DebrisField.js';
import { armProfile } from '../systems/HoldWingClear.js';
import { DEG2RAD } from '../core/MathUtil.js';

const M = Constants.SCENE_UNITS_PER_METER;
const S = Constants.ARM_STATES;
const AT_HOME = (st) => st === S.DOCKED || st === S.RELOADING;

/**
 * A held piece's mass (kg): ~5 kg at 1.2 m, scaling with size squared (a shell, not a solid). Must be > 0 for the
 * wing judge; feeds the carry's fuel bill.
 */
const massKgOf = (sizeM) => 5 * (sizeM / 1.2) ** 2;
/** strut rest angle (deg); matches REST_STRUT_DEG in test/_carryRig.js */
const REST_STRUT_DEG = 34;

/**
 * Radiators to `deg` at once (no slew), as `setFlowerTheta` in the node rigs; restarts the 180 -> 146 settle clock
 * (`THERMAL.FLOWER.RETURN_TO_OPEN_S`, 30 s).
 */
export function setRadiatorsNow(player, deg) {
  player._flowerTargetTheta = undefined;
  player._flowerThetaRad = deg * DEG2RAD;
  if (player._petalHolds) player._petalHolds.length = 0;
  player._flowerCmdClockS = player._flowerClockS || 0;
  player._writeFlowerPose();
  player.updateMatrixWorld?.(true);
}

/** Struts out as after the opening: every daughter's strut raised to `REST_STRUT_DEG` when lower (the ship starts folded at 0). */
export function deployStruts(player, armManager) {
  for (const a of armManager.arms) {
    if (!a || (a.getAimAlpha && a.getAimAlpha() >= REST_STRUT_DEG * DEG2RAD - 1e-6)) continue;
    a._strutTargetAlpha = undefined;
    a.setAimAlpha(REST_STRUT_DEG * DEG2RAD, 0);
  }
  if (typeof player._updateStruts === 'function') player._updateStruts(0);
}

/** Live pieces free to stage: alive, in play, not held, not pinned. */
function freePieces(debrisField) {
  const list = (debrisField && debrisField.debrisList) || [];
  return list.filter((d) => d && d.alive && !d._captured && !d._capturedByArm && !d._onboardingPinned && !d._armPinned && !d._stagedByHoldScenario);
}

/**
 * Take one piece: of `type` when asked, else a chunk-shaped fragment (not a plate), else the first free;
 * welcome-field pieces first. A piece is never retyped (its drawn shape is its mesh slot's).
 */
function takePiece(pool, type, isPlate) {
  const welcome = pool.filter((d) => d.welcomeSpawn);
  const from = welcome.length ? welcome : pool;
  const piece = (type && from.find((d) => d.type === type))
    || from.find((d) => d.type === 'fragment' && !(isPlate && isPlate(d)))
    || from[0];
  if (!piece) return null;
  pool.splice(pool.indexOf(piece), 1);
  return piece;
}

/**
 * Give `piece` the reproducible pseudo-random attitude number `seed` in her frame `herQ` (non-finite seed leaves it as is). The rack
 * freezes the attitude in her frame (`seedHerFrameAttitude`) and it decides how far her strut must rise to clear the wings.
 */
export function setAttitude(piece, seed, herQ = null) {
  if (!Number.isFinite(seed)) return;
  let x = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  for (let i = 0; i < 4; i++) rnd();
  const u = rnd(), v = rnd() * 2 * Math.PI, w = Math.acos(1 - 2 * rnd());
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.sin(w) * Math.cos(v), Math.sin(w) * Math.sin(v), Math.cos(w)), u * 2 * Math.PI);
  if (herQ) q.premultiply(herQ);            // seed is the attitude IN HER FRAME; the piece is drawn in world
  const sn = Math.sqrt(Math.max(1e-12, 1 - q.w * q.w));
  piece.tumbleAxis = new THREE.Vector3(q.x, q.y, q.z).multiplyScalar(q.w < 0 ? -1 / sn : 1 / sn).normalize();
  piece.tumbleAngle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

/** Size `piece` to `sizeM` as a held catch: no tumble, real size via the one size setter, unpaid. */
function prepPiece(piece, sizeM) {
  piece.mass = massKgOf(sizeM);
  DebrisField.setDebrisSize(piece, sizeM);
  piece.tumbleRate = 0;
  piece._initialTumbleRate = 0;
  piece._credited = true;               // GameFlowManager's per-body ledger skips it
  piece._stagedByHoldScenario = true;
  return piece;
}

/**
 * Put `piece` on `arm`'s rack as a reel-home ends: DOCKING with the dock timer elapsed, one `_updateDocking` stows
 * and pins it. @returns {boolean} reached HOLDING_CATCH
 */
function dockWithCatch(arm, piece, player) {
  piece._capturedByArm = arm;
  piece._captured = true;
  arm.capturedDebris = piece;
  arm._transitionTo(S.DOCKING);
  arm.stateTimer = Constants.ARM_DOCK_DURATION + 0.1;
  arm._updateDocking(0.016, player.position, player.quaternion);
  return arm.state === S.HOLDING_CATCH && arm.heldCatches.indexOf(piece) >= 0;
}

/**
 * Pin a free piece `fwdM` m ahead of the nose on the prograde line and select it, as `__netScenario` steps 4-5 (co-orbital first, then
 * the onboarding pin: the pin alone does not move a distant body). Nothing fires.
 * @returns {boolean}
 */
function pinTargetAhead(game, piece, fwdM) {
  const { player, debrisField, targetSelector } = game;
  const el = typeof player.getOrbitalElements === 'function' ? player.getOrbitalElements() : null;
  if (!el) return false;
  if (!piece.orbit) piece.orbit = {};
  Object.assign(piece.orbit, {
    semiMajorAxis: el.semiMajorAxis, eccentricity: el.eccentricity, inclination: el.inclination,
    raan: el.raan, argPerigee: el.argPerigee, meanMotion: el.meanMotion,
    trueAnomaly: el.trueAnomaly + (fwdM * M) / Math.max(1e-9, el.semiMajorAxis),
  });
  piece._onboardingPinned = true;
  piece._onboardingPinFwd = fwdM * M;
  piece._onboardingPinLat = 0;
  debrisField._onboardingPinIds?.add(piece.id);
  if (targetSelector && typeof targetSelector.setTarget === 'function') targetSelector.setTarget(piece);
  return true;
}

/**
 * What a mother-net press at a `sizeM` target would say now (`ArmManager.motherNetHolderBlock`, so it finishes a pending wing profile
 * as the press does), optionally with the radiators first moved to `deg` (no slew).
 * @returns {{block:number, daughter:number|null, kind:string|null, radiatorsDeg:number}} block: the refused daughter's index, -1 when none
 */
export function netBlockFor(game, sizeM, deg) {
  const { player, armManager } = game;
  if (Number.isFinite(deg)) setRadiatorsNow(player, deg);
  const block = armManager.motherNetHolderBlock({ sizeMeter: sizeM });
  // per holder: live strut angle, and whether it fouls that net's corridor (no foul = never refused)
  const radiusM = sizeM / 2 + (Constants.CAPTURE_NET.BERTH_CLEARANCE_M ?? 1.0);
  const holders = armManager.arms.filter((a) => a && a.heldCatches && a.heldCatches.length && typeof armManager._corridorFoulAt === 'function')
    .map((a) => {
      const alpha = a.getAimAlpha();
      return { daughter: a.index + 1, strutDeg: +(alpha / DEG2RAD).toFixed(2), fouls: !!armManager._corridorFoulAt(a.index, alpha, radiusM) };
    });
  return { block, daughter: block >= 0 ? block + 1 : null, kind: armManager._netBlockKind || null, radiatorsDeg: +(player._flowerThetaRad / DEG2RAD).toFixed(2), holders };
}

export function holdStatus(game) {
  const { player, armManager } = game;
  const daughters = (armManager.arms || []).map((a) => {
    const held = (a.heldCatches || [])[0] || null;
    const prof = armProfile(a);
    return {
      daughter: a.index + 1,
      state: a.state,
      strutDeg: a.getAimAlpha ? +(a.getAimAlpha() / DEG2RAD).toFixed(2) : null,
      catchSizeM: held ? +(held.sizeMeter ?? 0).toFixed(3) : null,
      catchType: held ? held.type : null,
      profile: prof.state === 0 ? 'none' : prof.state === 1 ? 'pending' : 'done',
      cMoves: typeof armManager.canMoveCatchToRadiator === 'function' ? !!armManager.canMoveCatchToRadiator(a.index) : null,
    };
  });
  return {
    radiatorsDeg: player ? +(player._flowerThetaRad / DEG2RAD).toFixed(2) : null,
    radiatorsTargetDeg: player && player._flowerTargetTheta !== undefined ? +(player._flowerTargetTheta / DEG2RAD).toFixed(2) : null,
    daughters,
  };
}

/**
 * @param {{player:object, armManager:object, debrisField:object, targetSelector?:object, cameraSystem?:object}} game the live objects
 * @param {{daughter?:number, sizeM?:number, radiatorsDeg?:number, fillOthers?:number|null, motherTarget?:number|null, type?:string}} [opts]
 *   daughter 1..4 (default 1); sizeM her catch (default 4); radiatorsDeg where the wings stand (default 146; 0, 146 or 180);
 *   fillOthers: the other daughters each hold a piece of that size; motherTarget: a piece of that size pinned 25 m ahead and selected;
 *   attSeed: a number picks HER piece's fixed attitude (reproducible; default: as it is);
 *   type: debris type of HER piece when the field has one (default: a chunk-shaped fragment; the welcome field has no rocket body).
 * @returns {{ok:boolean, reason?:string, status?:object, pieces?:object[]}} never throws
 */
export function stageHoldScenario(game, opts = {}) {
  try {
    const { player, armManager, debrisField } = game || {};
    if (!player || !armManager || !debrisField) return { ok: false, reason: 'sim not up' };
    const index = (Number.isInteger(opts.daughter) ? opts.daughter : 1) - 1;
    const sizeM = Number.isFinite(opts.sizeM) && opts.sizeM > 0 ? opts.sizeM : 4;
    const deg = Number.isFinite(opts.radiatorsDeg) ? opts.radiatorsDeg : 146;
    const fill = Number.isFinite(opts.fillOthers) && opts.fillOthers > 0 ? opts.fillOthers : null;
    const motherSize = Number.isFinite(opts.motherTarget) && opts.motherTarget > 0 ? opts.motherTarget : null;
    const arm = armManager.arms[index];
    if (!arm) return { ok: false, reason: `no daughter ${index + 1}` };
    const holders = [arm];
    if (fill !== null) for (const a of armManager.arms) if (a && a !== arm) holders.push(a);
    for (const a of holders) {
      if (a.heldCatches && a.heldCatches.length) return { ok: false, reason: `Daughter ${a.index + 1} already holds a catch; reload the page for a clean start` };
      if (!AT_HOME(a.state)) return { ok: false, reason: `Daughter ${a.index + 1} is not at home (${a.state}); reload the page for a clean start` };
    }
    const pool = freePieces(debrisField);
    const need = holders.length + (motherSize !== null ? 1 : 0);
    if (pool.length < need) return { ok: false, reason: `only ${pool.length} free pieces in the field, need ${need}` };

    game.cameraSystem?.skipIntroZoom?.();
    deployStruts(player, armManager);
    setRadiatorsNow(player, deg);

    const pieces = [];
    for (const a of holders) {
      const piece = prepPiece(takePiece(pool, a === arm ? opts.type : null, game.isPlate), a === arm ? sizeM : fill);
      if (a === arm) setAttitude(piece, opts.attSeed, a._herQuatWorldInto(player.quaternion, new THREE.Quaternion()));
      if (!dockWithCatch(a, piece, player)) return { ok: false, reason: `Daughter ${a.index + 1} did not reach HOLDING_CATCH (${a.state})` };
      pieces.push({ daughter: a.index + 1, id: piece.id, type: piece.type, sizeM: piece.sizeMeter });
    }
    if (motherSize !== null) {
      const target = takePiece(pool, null, game.isPlate);
      target.mass = 600;
      DebrisField.setDebrisSize(target, motherSize);
      target.brittleness = 0.3;
      target._stagedByHoldScenario = true;
      if (!pinTargetAhead(game, target, 25)) return { ok: false, reason: 'no player orbit for the mother-net target' };
      pieces.push({ motherTarget: true, id: target.id, type: target.type, sizeM: target.sizeMeter });
    }
    return { ok: true, pieces, status: holdStatus(game) };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}
