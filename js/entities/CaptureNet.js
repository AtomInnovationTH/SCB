/**
 * CaptureNet.js — Capture Net Projectile + System Manager
 * ST-9.4 C-6: Config G Capture Net (Sub-Tasks a–e)
 *
 * Implements the full net capture cycle per CAPTURE_NET.md:
 *   a) Net projectile + deploy mechanics (state machine, flight physics)
 *   b) Catch detection + tangle quality (cling probability, frag risk)
 *   c) Reel-in + tension (motor reel, abort/release)
 *   d) Stow + cargo hand-off (inventory depletion, debris transfer)
 *   e) HUD indicators (inventory tracking, reel progress, captured mass)
 *
 * All behavior gated behind FEATURE_FLAGS.CAPTURE_NET (default false).
 *
 * @module entities/CaptureNet
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { BridleRing } from './BridleRing.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';

const CN = Constants.CAPTURE_NET;
const STATES = CN.STATES;
const MODES = CN.MODES;
const FEATURE_FLAGS = Constants.FEATURE_FLAGS;

// ═══════════════════════════════════════════════════════════════════════════
// §1  Pure Functions — Cling Probability + Frag Risk
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the net class spec for a given platform type.
 * @param {'mother'|'weaver'|'spinner'} type
 * @returns {object} Net class constants (LARGE, MEDIUM, or SMALL)
 */
export function getNetClassForType(type) {
  if (type === 'mother')  return CN.LARGE;
  if (type === 'weaver')  return CN.MEDIUM;
  if (type === 'spinner') return CN.SMALL;
  return CN.MEDIUM; // fallback
}

/**
 * Compute cling probability P_cling for a capture attempt.
 * Per CAPTURE_NET.md §3.3:
 *   P_cling = P_base × f_velocity × f_contact × f_roughness × f_spin × f_tension × f_distance
 *
 * @param {object} params
 * @param {number} params.pBase     — base probability for net class + target match (§3.4)
 * @param {number} params.vRel      — relative velocity at contact (m/s)
 * @param {number} params.vOptimal  — optimal wrap velocity (≈ launch speed)
 * @param {number} params.range     — distance from launcher to target (m)
 * @param {number} [params.contactFraction=1]  — mesh contact area / target area
 * @param {number} [params.roughness=1]        — surface roughness (0.4=smooth, 0.7=painted, 1.0=MLI)
 * @param {number} [params.spinFraction=1]     — ω_impact / ω_design
 * @param {number} [params.tensionFraction=1]  — T_tether / T_nominal
 * @returns {number} P_cling ∈ [0, 1]
 */
export function computeClingProbability(params) {
  const {
    pBase,
    vRel,
    vOptimal = 10,
    range = 50,
    contactFraction = 1.0,
    roughness = 1.0,
    spinFraction = 1.0,
    tensionFraction = 1.0,
  } = params;

  const vRange = 10; // m/s velocity range for clamp
  const fVelocity  = Math.max(0.3, Math.min(1.0, 1.0 - Math.abs(vRel - vOptimal) / vRange));
  const fContact   = Math.min(contactFraction, 1.0);
  const fRoughness = roughness;
  const fSpin      = Math.max(0.5, Math.min(1.2, spinFraction));
  const fTension   = Math.max(0.6, Math.min(1.0, tensionFraction));
  // Distance modifier: f_distance = clamp(1.1 - 0.003 × range, 0.85, 1.1)
  const fDistance   = Math.max(0.85, Math.min(1.1, 1.1 - 0.003 * range));

  const raw = pBase * fVelocity * fContact * fRoughness * fSpin * fTension * fDistance;
  return Math.max(0, Math.min(1, raw)); // clamp to valid probability
}

/**
 * Compute the distance modifier alone (for HUD pre-fire display).
 * @param {number} range — metres
 * @returns {number} f_distance ∈ [0.85, 1.1]
 */
export function computeDistanceModifier(range) {
  return Math.max(0.85, Math.min(1.1, 1.1 - 0.003 * range));
}

/**
 * Compute fragmentation risk based on target fragility and impact KE.
 * Per CAPTURE_NET.md §5.1–§5.4.
 *
 * @param {object} params
 * @param {number} params.netMass       — net mass in kg
 * @param {number} params.vRel          — relative velocity at contact (m/s)
 * @param {number} params.targetFragility — base frag risk for debris class (§5.4, 0–1)
 * @param {number} params.range         — distance (m)
 * @returns {number} frag risk ∈ [0, 1]
 */
export function computeFragRisk(params) {
  const { netMass, vRel, targetFragility = 0.05, range = 50 } = params;
  // Impact kinetic energy: ΔKE = ½ × m_net × v_rel²
  const ke = 0.5 * netMass * vRel * vRel;
  // Reference KE: Medium Net at 10 m/s = 34 J
  const keScale = Math.min(ke / 34, 2.0);
  let risk = targetFragility * keScale;

  // Distance modifier (§3.3 QA Q-4)
  if (range < CN.CLOSE_RANGE) {
    risk *= 0.5;  // halved at close range
  } else if (range > CN.BASELINE_RANGE_MAX) {
    risk *= 1.5;  // increased at edge of envelope
  }

  return Math.max(0, Math.min(1, risk));
}

/**
 * Auto-recommend capture mode based on target data.
 * Per CAPTURE_NET.md §3.6.
 *
 * @param {object} target — debris with optional .hasSolarPanels, .surfaceRoughness, .vRel
 * @returns {'SLAM_WRAP'|'CINCH'}
 */
export function recommendCaptureMode(target) {
  if (!target) return MODES.SLAM_WRAP;
  if (target.hasSolarPanels)  return MODES.CINCH;
  if ((target.vRel || 0) > 5) return MODES.CINCH;
  if ((target.surfaceRoughness || 1.0) < 0.5) return MODES.CINCH;
  return MODES.SLAM_WRAP;
}


// ═══════════════════════════════════════════════════════════════════════════
// §2  NetProjectile — Per-Net State Machine
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Represents a single net in flight through its full capture cycle.
 *
 * State machine (CAPTURE_NET.md §2.4):
 *   FOLDED → LAUNCHING → SPINNING_UP → FLIGHT →
 *     (slam) CONTACT → SECURE_CHECK → CAPTURED/MISSED → REELING → STOWED
 *     (cinch) BRAKE → ENVELOP → CINCH_CLOSING → SECURE_CHECK → CAPTURED/MISSED → REELING → STOWED
 *     (abort at any active state) → RELEASED
 */
export class NetProjectile {
  /**
   * @param {object} config
   * @param {object} config.netClass       — one of CN.LARGE / CN.MEDIUM / CN.SMALL
   * @param {number} config.armIndex       — daughter arm index (-1 for mother pod)
   * @param {number} [config.podIndex=-1]  — mother pod index (0 or 1, -1 for daughter)
   * @param {object} config.launchPosition — {x, y, z} in metres
   * @param {object} config.launchDirection — normalised {x, y, z}
   * @param {object} [config.targetDebris] — target with .position, .mass, .id
   * @param {string} [config.captureMode]  — 'SLAM_WRAP' or 'CINCH'
   */
  constructor(config) {
    this.netClass       = config.netClass;
    this.armIndex       = config.armIndex;
    this.podIndex       = config.podIndex ?? -1;
    this.launchPosition = { ...config.launchPosition };
    this.launchDirection = { ...config.launchDirection };
    this.targetDebris   = config.targetDebris || null;
    this.captureMode    = config.captureMode || MODES.SLAM_WRAP;

    /** @type {object|null} Reference to source arm for inventory restoration (§3.5) */
    this._sourceArm     = config.sourceArm || null;

    /** @type {boolean} Daughter capture being hauled by the ArmUnit — hold the
     *  net's own reel (bag stays cinched on the debris) until the arm delivers. */
    this._heldByArm     = false;

    // ── Runtime state ──
    this.state         = STATES.LAUNCHING;
    this.stateTimer    = 0;
    this.flightTime    = 0;
    this.distanceTraveled = 0;
    this.position      = { ...this.launchPosition };
    this.speed         = this.netClass.LAUNCH_SPEED;
    this.spinRate      = 0;           // current Hz
    this.tetherPaidOut = 0;           // metres
    this.reelProgress  = 0;           // 0..1
    this.capturedMass  = 0;           // kg of captured debris
    this.tangleQuality = 0;           // 0..1: higher is better wrap
    this.tensionN      = 0;           // current tension in Newtons
    this.isActive      = true;
    this.catchResult   = null;        // 'success' | 'miss' | null

    // Diagnostics (for tests / HUD)
    this._clingRoll        = 0;
    this._clingProbability = 0;
    this._fragRisk         = 0;

    // Flag for CaptureNetSystem to detect state changes from forceResolve()
    this._resultProcessed  = false;

    // ── Q2 Ceremony event emission guards (CEREMONY_REDESIGN.md §5.2) ──
    this._ceremonyStartEmitted    = false;
    this._brakeImminentEmitted    = false;
    this._brakeFiredEmitted       = false;
    this._envelopPeakEmitted      = false;
    this._ceremonyCompleteEmitted = false;
    this._lastCinchBucket         = -1;
  }

  // ── Tick ────────────────────────────────────────────────────────────────

  /**
   * Advance the state machine by dt seconds.
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    if (!this.isActive) return;

    // Q2 Ceremony: emit start event on first tick.
    // NOTE: emitted BEFORE the scale read below so that CameraSystem's
    // _onNetCeremonyStart handler (synchronous via EventBus) can publish the
    // first beat's timeScale to CeremonyTimeScale before we apply it.
    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyStartEmitted) {
      this._ceremonyStartEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_START, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        netClass: this.netClass.CODE,
      });
    }

    // Stage 4 (CEREMONY_REDESIGN.md §5, §6 R1): apply ceremony time-dilation to
    // THIS projectile's internal dt only. World dt (orbital propagation,
    // debris field, conjunctions, station-keep, etc.) is unaffected — the
    // scaling happens here, not at the caller (captureNetSystem.update). When
    // the flag is OFF or no ceremony is active, CeremonyTimeScale.get() === 1.0
    // (short-circuit) and this is a no-op multiply.
    const scale = FEATURE_FLAGS.NET_CEREMONY ? CeremonyTimeScale.get() : 1.0;
    dt = dt * scale;

    this.stateTimer += dt;

    // 2026-05-25 — Q2 visual-drift fix (THE "NET DISAPPEARS" BUG).
    //
    // Only `_updateFlight` updates `this.position` from the arm's current
    // scene position; `_updateBrake/Envelop/CinchClosing/SecureCheck` do NOT.
    // After contact, `net.position` therefore FREEZES at the arm's position
    // at the moment of contact, while the arm itself keeps orbiting at
    // ~7 km/s (LEO). [`CaptureNetVisual.update`](js/ui/CaptureNetVisual.js:484)
    // reads `net.position * M` every frame and places the visual group there,
    // so the visual is locked to a stale world point that drifts off-frame
    // within ~1 s of contact.
    //
    // CameraSystem._computeNetScenePos meanwhile uses `arm.position + launchDir
    // * distanceTraveled * M` (CURRENT arm position), so the camera tracks the
    // arm's co-orbiting frame. Result: camera and visual end up in different
    // reference frames, and the user sees the bag VANISH right when the
    // engulf/cinch should start playing — exactly the user-reported symptom.
    //
    // Fix: keep `this.position` synced to the arm's current scene position
    // during ALL post-FLIGHT states.  Each block below documents WHY:
    //
    //   CONTACT/BRAKE/ENVELOP/CINCH_CLOSING/SECURE_CHECK — visual stays
    //     anchored at the launch-distance point in the arm's co-orbiting
    //     frame (FLIGHT already does this work; running it twice is harmless).
    //
    //   REELING — 2026-05-28 (Item 2 fix): _updateReeling had a misleading
    //     comment claiming it "has its own position logic", but it only
    //     updates reelProgress (a 0→1 scalar), not position.  Result: net
    //     visual froze at the orbital-frame contact point while the arm
    //     co-orbited at 7 km/s, so the user saw the net VANISH the moment
    //     REELING started.  Now we track the arm AND slide the effective
    //     launch distance from `tetherPaidOut → 0` as reelProgress
    //     advances 0→1, so the net visually reels in toward the arm.
    if (this._sourceArm?.position
        && (this.state === STATES.CONTACT
            || this.state === STATES.BRAKE
            || this.state === STATES.ENVELOP
            || this.state === STATES.CINCH_CLOSING
            || this.state === STATES.SECURE_CHECK)) {
      const M_NET = 0.00001;
      const ap = this._sourceArm.position;
      this.position.x = ap.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = ap.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = ap.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    } else if (this._sourceArm?.position && this.state === STATES.REELING) {
      const M_NET = 0.00001;
      // 2026-06-05 (v2 — visual-only, no physics coupling): for a SUCCESSFUL
      // catch, keep the bag locked ONTO the captured debris so the cinched net
      // and its catch never separate while the daughter hauls it home (the
      // user-reported "net doesn't cinch around / bring back the debris" bug).
      // We follow the debris's live scene position — which DebrisField already
      // drives (its orbit until the daughter snaps onto it, then the daughter's
      // position) — and seat the bag apex one mouth-radius BEHIND the debris
      // along the launch axis, so the forward drawstring ring wraps the debris's
      // FAR side (opposite the daughter). This ONLY writes the net's visual
      // position; nothing reads net.position back into the arm/debris/autopilot,
      // so there is no feedback or station-keep coupling.
      const sp = (this.catchResult === 'success') ? this.targetDebris?._scenePosition : null;
      if (sp) {
        const back = this.netClass.DIAMETER / 2;   // mouth radius (m), apex standoff
        this.position.x = sp.x / M_NET - this.launchDirection.x * back;
        this.position.y = sp.y / M_NET - this.launchDirection.y * back;
        this.position.z = sp.z / M_NET - this.launchDirection.z * back;
      } else {
        // Empty net (miss) — reel the bag back to the arm. Effective launch
        // distance shrinks from `tetherPaidOut` (contact distance) toward 0 as
        // `reelProgress` advances 0→1; at progress=1 the net rendezvous with the
        // arm.
        const ap = this._sourceArm.position;
        const eff = this.tetherPaidOut * Math.max(0, 1 - this.reelProgress);
        this.position.x = ap.x / M_NET + this.launchDirection.x * eff;
        this.position.y = ap.y / M_NET + this.launchDirection.y * eff;
        this.position.z = ap.z / M_NET + this.launchDirection.z * eff;
      }
    }

    switch (this.state) {
      case STATES.LAUNCHING:     this._updateLaunching(dt);   break;
      case STATES.SPINNING_UP:   this._updateSpinningUp(dt);  break;
      case STATES.FLIGHT:        this._updateFlight(dt);      break;
      case STATES.CONTACT:       this._updateContact(dt);     break;
      case STATES.BRAKE:         this._updateBrake(dt);       break;
      case STATES.ENVELOP:       this._updateEnvelop(dt);     break;
      case STATES.CINCH_CLOSING: this._updateCinchClosing(dt); break;
      case STATES.SECURE_CHECK:  this._updateSecureCheck(dt); break;
      case STATES.REELING:       this._updateReeling(dt);     break;
      // Terminal states — no tick
      case STATES.CAPTURED:
      case STATES.MISSED:
      case STATES.STOWED:
      case STATES.RELEASED:
      case STATES.FOLDED:
        break;
    }
  }

  // ── State transitions ──────────────────────────────────────────────────

  /** @private */
  _transitionTo(newState) {
    this.state = newState;
    this.stateTimer = 0;
  }

  /** Phase 1: Crossbow release (0.15 s) */
  _updateLaunching(dt) {
    if (this.stateTimer >= CN.CAST_WINDUP) {
      this._transitionTo(STATES.SPINNING_UP);
    }
  }

  /** Phase 2: Yo-yo despin spin-up (0.5 s) */
  _updateSpinningUp(dt) {
    const fraction = Math.min(this.stateTimer / CN.SPIN_UP_TIME, 1);
    this.spinRate = fraction * this.netClass.SPIN_HZ;
    if (this.stateTimer >= CN.SPIN_UP_TIME) {
      this.spinRate = this.netClass.SPIN_HZ;
      this._transitionTo(STATES.FLIGHT);
    }
  }

  /** Phase 3: Tether pay-out + target intersection check */
  _updateFlight(dt) {
    this.flightTime += dt;
    const dist = this.speed * dt;
    this.distanceTraveled += dist;
    this.tetherPaidOut += dist;

    // Update position along launch direction (metres, for CaptureNetVisual + test path)
    this.position.x += this.launchDirection.x * dist;
    this.position.y += this.launchDirection.y * dist;
    this.position.z += this.launchDirection.z * dist;

    // PROD path: also update position from arm's current co-orbiting frame
    // so CaptureNetVisual renders the net near the arm, not 7 km behind.
    const M_NET = 0.00001;  // 1 m in scene units (matches ArmUnit.M)
    if (this._sourceArm?.position) {
      const ap = this._sourceArm.position;  // THREE.Vector3, scene units, updated each frame
      this.position.x = ap.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = ap.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = ap.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    }

    // Check max flight time (§2.4 phase 3)
    if (this.flightTime >= CN.MAX_FLIGHT_TIME) {
      this._miss('timeout');
      return;
    }

    // Check tether limit
    if (this.tetherPaidOut >= this.netClass.TETHER_MAX) {
      this._miss('tether_limit');
      return;
    }

    // Check range to target (intersection = distance < net radius)
    // PROD: use arm-relative scene position (co-orbiting reference frame).
    // TEST: use absolute metres (mock .position, no _sourceArm).
    if (this.targetDebris) {
      const sp = this.targetDebris._scenePosition;
      const ap = this._sourceArm?.position;
      if (sp && ap) {
        // Net scene pos = arm scene pos + flight displacement (scene units)
        const netX = ap.x + this.launchDirection.x * this.distanceTraveled * M_NET;
        const netY = ap.y + this.launchDirection.y * this.distanceTraveled * M_NET;
        const netZ = ap.z + this.launchDirection.z * this.distanceTraveled * M_NET;
        const dx = sp.x - netX;
        const dy = sp.y - netY;
        const dz = sp.z - netZ;
        const distScene = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const radiusScene = (this.netClass.DIAMETER / 2) * M_NET;
        // Q2 Ceremony: brake-imminent lookahead (cinch path only)
        if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeImminentEmitted
            && this.captureMode === MODES.CINCH) {
          const brakeThreshScene = (this.speed * 0.3 + this.netClass.DIAMETER / 2) * M_NET;
          if (distScene <= brakeThreshScene) {
            this._brakeImminentEmitted = true;
            eventBus.emit(Events.NET_BRAKE_IMMINENT, {
              armIndex: this.armIndex,
              podIndex: this.podIndex,
              tMinus: 0.3,
            });
          }
        }
        if (distScene <= radiusScene) {
          if (this.captureMode === MODES.CINCH) {
            this._transitionTo(STATES.BRAKE);
          } else {
            this._transitionTo(STATES.CONTACT);
          }
        }
      } else {
        // Test fallback: .position in metres, no orbital motion
        const tp = this.targetDebris.position || this.targetDebris;
        const dx = (tp.x || 0) - this.position.x;
        const dy = (tp.y || 0) - this.position.y;
        const dz = (tp.z || 0) - this.position.z;
        const distToTarget = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // Q2 Ceremony: brake-imminent lookahead (cinch path only)
        if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeImminentEmitted
            && this.captureMode === MODES.CINCH) {
          const brakeThresh = this.speed * 0.3 + this.netClass.DIAMETER / 2;
          if (distToTarget <= brakeThresh) {
            this._brakeImminentEmitted = true;
            eventBus.emit(Events.NET_BRAKE_IMMINENT, {
              armIndex: this.armIndex,
              podIndex: this.podIndex,
              tMinus: 0.3,
            });
          }
        }
        if (distToTarget <= this.netClass.DIAMETER / 2) {
          if (this.captureMode === MODES.CINCH) {
            this._transitionTo(STATES.BRAKE);
          } else {
            this._transitionTo(STATES.CONTACT);
          }
        }
      }
    }
  }

  /** Phase 5a: Slam-wrap contact */
  _updateContact(dt) {
    if (this.stateTimer >= CN.SLAM_CONTACT_TIME) {
      this._transitionTo(STATES.SECURE_CHECK);
    }
  }

  /** Phase 5b-A: Tether brake (cinch path) */
  _updateBrake(dt) {
    // Q2 Ceremony: emit brake-fired on state entry
    if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeFiredEmitted) {
      this._brakeFiredEmitted = true;
      eventBus.emit(Events.NET_BRAKE_FIRED, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        tetherTensionN: this.tensionN,
      });
    }
    if (this.stateTimer >= CN.BRAKE_TIME) {
      this._transitionTo(STATES.ENVELOP);
    }
  }

  /** Phase 5b-B: Rim weights sweep past target */
  _updateEnvelop(dt) {
    // Q2 Ceremony: emit envelop peak at 50% of ENVELOP_TIME
    if (FEATURE_FLAGS.NET_CEREMONY && !this._envelopPeakEmitted
        && this.stateTimer >= CN.ENVELOP_TIME * 0.5) {
      this._envelopPeakEmitted = true;
      eventBus.emit(Events.NET_ENVELOP_PEAK, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
      });
    }
    if (this.stateTimer >= CN.ENVELOP_TIME) {
      this._transitionTo(STATES.CINCH_CLOSING);
    }
  }

  /** Phase 5b-C: Drawstring cinch closing */
  _updateCinchClosing(dt) {
    // Q2 Ceremony: emit cinch progress at discrete 10% thresholds
    if (FEATURE_FLAGS.NET_CEREMONY) {
      const fraction = Math.min(this.stateTimer / CN.CINCH_CLOSE_TIME, 1);
      const bucket = Math.floor(fraction * 10);
      if (bucket !== this._lastCinchBucket) {
        this._lastCinchBucket = bucket;
        eventBus.emit(Events.NET_CINCH_PROGRESS, {
          armIndex: this.armIndex,
          podIndex: this.podIndex,
          fraction,
        });
      }
    }
    if (this.stateTimer >= CN.CINCH_CLOSE_TIME) {
      this._transitionTo(STATES.SECURE_CHECK);
    }
  }

  /** Phase 6: Secure check — resolve capture probability */
  _updateSecureCheck(dt) {
    if (this.stateTimer >= CN.SECURE_CHECK_TIME) {
      this._resolveCatch();
    }
  }

  /** Phase 7: Reel-in — motor pulls net+debris back */
  _updateReeling(dt) {
    // ── Held daughter catch: keep the bag cinched on the debris until the arm
    // delivers it. The net's own reel is short (tetherPaidOut/REEL_SPEED) and
    // would otherwise STOW — removing the bag visual — long before the daughter
    // finishes hauling, so the netted catch appeared to vanish mid-haul. The
    // position-follow above keeps the bag locked onto the debris while we hold;
    // we release the hold (and stow) once the catch is no longer pinned to a
    // captor: docked (debris removed/alive=false, pin cleared), net failure
    // (pin cleared), or tether snap's bounded drift (pin finally cleared).
    if (this._heldByArm) {
      const d = this.targetDebris;
      const stillHauling = !!(d && d.alive !== false && d._capturedByArm);
      if (stillHauling) {
        this.tensionN = 1.0 + this.capturedMass * 0.1;
        return;                       // hold: no completion while the arm hauls
      }
      this._heldByArm = false;        // delivered / lost → stow promptly
      this.reelProgress = 1.0;
    }

    if (this.tetherPaidOut <= 0) {
      // Edge case: net fired but didn't travel
      this.reelProgress = 1.0;
    } else {
      const reelRate = this.netClass.REEL_SPEED / Math.max(1, this.tetherPaidOut);
      this.reelProgress = Math.min(1.0, this.reelProgress + reelRate * dt);
    }

    // Tension: base + mass factor (simplified — real model in ST-9.5)
    this.tensionN = 1.0 + this.capturedMass * 0.1;

    if (this.reelProgress >= 1.0) {
      this._transitionTo(STATES.STOWED);
      this.isActive = false;
      eventBus.emit(Events.NET_REEL_COMPLETED, {
        armIndex:     this.armIndex,
        podIndex:     this.podIndex,
        capturedMass: this.capturedMass,
        debrisId:     this.targetDebris?.id,
      });
    }
  }

  // ── Catch resolution ───────────────────────────────────────────────────

  /** @private Roll cling probability and resolve capture */
  _resolveCatch() {
    // Determine P_base from capture mode
    const pBase = this.captureMode === MODES.CINCH
      ? CN.CINCH_P_BASE.RIGHT_HARDER   // 0.93 — default for cinch
      : CN.SLAM_P_BASE.RIGHT_HARDER;   // 0.80 — default for slam

    const params = {
      pBase,
      vRel:            this.speed,
      vOptimal:        this.netClass.LAUNCH_SPEED,
      range:           this.distanceTraveled,
      spinFraction:    this.spinRate / this.netClass.SPIN_HZ,
      tensionFraction: 1.0,
      contactFraction: 1.0,
      roughness:       this.targetDebris?.surfaceRoughness || 1.0,
    };

    this._clingProbability = computeClingProbability(params);
    this._clingRoll = Math.random();

    // Frag risk (for diagnostics / future consequence system)
    this._fragRisk = computeFragRisk({
      netMass:         this.netClass.MASS,
      vRel:            this.speed,
      targetFragility: this.targetDebris?.fragility || 0.05,
      range:           this.distanceTraveled,
    });

    if (this._clingRoll <= this._clingProbability) {
      this._captureSuccess();
    } else {
      this._miss('cling_failed');
    }
  }

  /** @private Transition to CAPTURED + emit event */
  _captureSuccess() {
    this.catchResult = 'success';
    this.capturedMass = this.targetDebris?.mass || 1.0;
    this.tangleQuality = this._clingProbability;
    this._transitionTo(STATES.CAPTURED);

    eventBus.emit(Events.NET_CATCH_SUCCESS, {
      armIndex:      this.armIndex,
      podIndex:      this.podIndex,
      debrisId:      this.targetDebris?.id,
      tangleQuality: this.tangleQuality,
      capturedMass:  this.capturedMass,
      mode:          this.captureMode,
    });

    // Q2 Ceremony: emit ceremony complete
    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyCompleteEmitted) {
      this._ceremonyCompleteEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        mode:     this.captureMode,
        success:  true,
      });
    }
  }

  /** @private Transition to MISSED + emit event */
  _miss(reason) {
    this.catchResult = 'miss';
    this._transitionTo(STATES.MISSED);

    eventBus.emit(Events.NET_CATCH_MISS, {
      armIndex:    this.armIndex,
      podIndex:    this.podIndex,
      debrisId:    this.targetDebris?.id,
      probability: this._clingProbability,
      reason,
    });

    // Q2 Ceremony: emit ceremony complete
    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyCompleteEmitted) {
      this._ceremonyCompleteEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        mode:     this.captureMode,
        success:  false,
      });
    }
  }

  // ── Player Commands ────────────────────────────────────────────────────

  /**
   * Start reel-in (player command after catch or miss).
   * @returns {boolean} Whether reel started
   */
  startReel() {
    if (this.state !== STATES.CAPTURED && this.state !== STATES.MISSED) return false;
    this._transitionTo(STATES.REELING);
    this.reelProgress = 0;

    eventBus.emit(Events.NET_REEL_STARTED, {
      armIndex: this.armIndex,
      podIndex: this.podIndex,
      hasCatch: this.catchResult === 'success',
    });
    return true;
  }

  /**
   * Release / abort: let debris and net go. Net inventory is consumed.
   * @returns {boolean} Whether release occurred
   */
  release() {
    if (this.state !== STATES.CAPTURED &&
        this.state !== STATES.REELING &&
        this.state !== STATES.FLIGHT) return false;

    this._transitionTo(STATES.RELEASED);
    this.capturedMass = 0;
    this.isActive = false;

    eventBus.emit(Events.NET_RELEASED, {
      armIndex: this.armIndex,
      podIndex: this.podIndex,
      debrisId: this.targetDebris?.id,
    });
    return true;
  }

  /**
   * Force the net into a deterministic result (for testing / scripted events).
   * Bypasses the random roll.
   *
   * @param {boolean} success — true for catch, false for miss
   * @param {number} [probability=1.0] — cling probability to report
   */
  forceResolve(success, probability = 1.0) {
    this._clingProbability = probability;
    this._clingRoll = success ? 0 : 1;
    if (success) {
      this._captureSuccess();
    } else {
      this._miss('forced');
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §3  CaptureNetSystem — Fleet-Wide Net Manager
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manages all active net projectiles, mother pod inventory, cooldowns,
 * and provides query APIs for HUD (§ST-9.4e).
 *
 * Singleton, gated behind FEATURE_FLAGS.CAPTURE_NET.
 */
export class CaptureNetSystem {
  constructor() {
    /** @type {NetProjectile[]} Active nets in flight / capture / reel */
    this.activeNets = [];

    // Mother Large Net pod inventory: [podA_count, podB_count]
    this._motherPodInventory = [0, 0];
    this._motherPodMax       = [0, 0];

    /** @type {Map<string, number>} Cooldown timers keyed by 'pod_0', 'arm_3', etc. */
    this._cooldownTimers = new Map();

    this._initialized = false;

    // First-fragmentation mercy rule (§5.7)
    this._playerHasFragmented = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialise inventory to Dyneema Y0 defaults.
   * Called once at game start / after load.
   */
  init() {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    this._motherPodInventory = [CN.LARGE.MAGAZINE_SIZE, CN.LARGE.MAGAZINE_SIZE];
    this._motherPodMax       = [CN.LARGE.MAGAZINE_SIZE, CN.LARGE.MAGAZINE_SIZE];
    this._initialized = true;

    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'mother',
      podInventory: [...this._motherPodInventory],
    });
  }

  /**
   * Per-frame update: advance all active net projectiles + cooldowns.
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    // Tick cooldowns
    for (const [key, remaining] of this._cooldownTimers.entries()) {
      const next = remaining - dt;
      if (next <= 0) {
        this._cooldownTimers.delete(key);
      } else {
        this._cooldownTimers.set(key, next);
      }
    }

    // Tick active nets
    for (let i = this.activeNets.length - 1; i >= 0; i--) {
      const net = this.activeNets[i];
      const prevState = net.state;

      net.update(dt);

      // Auto-start reel on capture/miss — detects both in-loop transitions
      // AND external state changes (e.g. forceResolve called between updates)
      const needsAutoReel = (net.state === STATES.CAPTURED || net.state === STATES.MISSED)
        && !net._resultProcessed;
      if (needsAutoReel) {
        net._resultProcessed = true;
        const cooldown = net.catchResult === 'success'
          ? CN.COOLDOWN_CATCH
          : CN.COOLDOWN_MISS;
        const key = net.armIndex >= 0 ? `arm_${net.armIndex}` : `pod_${net.podIndex}`;
        this._cooldownTimers.set(key, cooldown);

        // Daughter captures are hauled home by the ArmUnit, not reeled by the
        // net itself. Hold the net's reel (bag stays cinched on the debris) so
        // the netted catch doesn't visually vanish mid-haul; _updateReeling
        // auto-releases the hold once the daughter delivers (debris unpinned).
        // Mother-pod captures (podIndex≥0) and misses reel/stow normally.
        if (net.armIndex >= 0 && net.catchResult === 'success') {
          net._heldByArm = true;
        }

        // Auto-start reel (player can still release / override)
        net.startReel();
      }

      // Remove terminal nets + handle inventory / cargo consequences
      if (!net.isActive || net.state === STATES.STOWED || net.state === STATES.RELEASED) {
        // §3.5: Net is NOT consumed on miss — restore inventory when empty net reels back
        if (net.state === STATES.STOWED && net.catchResult === 'miss') {
          this._restoreNetInventory(net);
        }

        // ST-9.4d: Cargo hand-off — successful capture reeled to platform
        if (net.state === STATES.STOWED && net.catchResult === 'success' && net.capturedMass > 0) {
          // ST-9.7 C-8: Route through bridle ring if both flags enabled
          if (Constants.FEATURE_FLAGS.BRIDLE_RING && Constants.FEATURE_FLAGS.CAPTURE_NET && net.armIndex >= 0) {
            const freePoint = BridleRing.findFreePoint(net.armIndex);
            if (freePoint) {
              const captureId = net.targetDebris?.id || `capture-${Date.now()}`;
              BridleRing.attach(net.armIndex, freePoint, captureId, net.capturedMass);
              // Brief intermediary — immediately release to cargo system
              BridleRing.detach(net.armIndex, freePoint);
            }
          }

          eventBus.emit(Events.CARGO_STORE, {
            debrisId:     net.targetDebris?.id,
            mass:         net.capturedMass,
            source:       net.armIndex >= 0 ? 'daughter' : 'mother',
            armIndex:     net.armIndex,
            podIndex:     net.podIndex,
            netCapture:   true,
          });
        }

        this.activeNets.splice(i, 1);
      }
    }
  }

  /**
   * Restore net inventory after a miss (§3.5: net is reusable, not consumed).
   * @private
   * @param {NetProjectile} net
   */
  _restoreNetInventory(net) {
    if (net.podIndex >= 0) {
      // Mother pod — increment pod inventory
      if (this._motherPodInventory[net.podIndex] < this._motherPodMax[net.podIndex]) {
        this._motherPodInventory[net.podIndex]++;
        eventBus.emit(Events.NET_INVENTORY_CHANGED, {
          source: 'mother',
          podInventory: [...this._motherPodInventory],
        });
      }
    } else if (net._sourceArm && typeof net._sourceArm.setNetInventory === 'function') {
      // Daughter arm — restore via arm reference
      const current = (typeof net._sourceArm.getNetInventory === 'function')
        ? net._sourceArm.getNetInventory() : 0;
      net._sourceArm.setNetInventory(current + 1);
      eventBus.emit(Events.NET_INVENTORY_CHANGED, {
        source: 'daughter',
        armIndex: net.armIndex,
        remaining: net._sourceArm.getNetInventory(),
      });
    }
  }

  /**
   * Reset to clean state (game reset / new session).
   */
  reset() {
    this.activeNets = [];
    this._cooldownTimers.clear();
    this._motherPodInventory = [0, 0];
    this._motherPodMax       = [0, 0];
    this._initialized = false;
    this._playerHasFragmented = false;
  }

  // ── Fire Commands ──────────────────────────────────────────────────────

  /**
   * Fire a Large Net from a mother pod.
   *
   * @param {number} podIndex   — 0 (Pod A) or 1 (Pod B)
   * @param {object} launchPos  — world position {x, y, z} in metres
   * @param {object} launchDir  — normalised direction {x, y, z}
   * @param {object} target     — debris object (with .position, .mass, .id)
   * @param {string} [mode]     — 'SLAM_WRAP' or 'CINCH' (auto-recommend if omitted)
   * @returns {NetProjectile|null} The created projectile, or null on failure
   */
  fireMotherNet(podIndex, launchPos, launchDir, target, mode) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return null;
    if (podIndex < 0 || podIndex > 1) return null;
    if (this._motherPodInventory[podIndex] <= 0) return null;
    if (this._cooldownTimers.has(`pod_${podIndex}`)) return null;

    // Deplete inventory
    this._motherPodInventory[podIndex]--;

    // CEREMONY_REDESIGN §4 / NET_CEREMONY alignment (2026-05-25):
    // When NET_CEREMONY is on, the ceremony's beats 5–6 (BRAKE_ENVELOP, CINCH)
    // assume the CINCH FSM path. SLAM_WRAP physics skips ENVELOP and CINCH_CLOSING
    // entirely (CONTACT → SECURE_CHECK → CAPTURED in <1 s game-time), so the
    // visual renders no engulf or cinch animation during those beats — confirmed
    // by browser log ([NET_CINEMATIC] CEREMONY_START captureMode=SLAM_WRAP) and
    // by inspecting [`CaptureNet._updateContact`](js/entities/CaptureNet.js:387).
    // Force CINCH when the auto-recommender would otherwise pick SLAM_WRAP, so
    // the FSM traverses BRAKE→ENVELOP→CINCH_CLOSING and the ceremony visual
    // matches the camera beats. Explicit `mode` argument is still honoured
    // (preserves test paths and future explicit-mode UI). CINCH_P_BASE is
    // ≥ SLAM_P_BASE in all pairings, so no score regression.
    let resolvedMode = mode || recommendCaptureMode(target);
    if (!mode && Constants.FEATURE_FLAGS.NET_CEREMONY) {
      resolvedMode = MODES.CINCH;
    }

    const net = new NetProjectile({
      netClass:       CN.LARGE,
      armIndex:       -1,
      podIndex,
      launchPosition: launchPos,
      launchDirection: launchDir,
      targetDebris:   target,
      captureMode:    resolvedMode,
    });

    this.activeNets.push(net);

    eventBus.emit(Events.NET_FIRED, {
      source:   'mother',
      podIndex,
      netClass: 'LARGE',
      remaining: this._motherPodInventory[podIndex],
    });

    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'mother',
      podInventory: [...this._motherPodInventory],
    });

    return net;
  }

  /**
   * Fire a net from a daughter arm (Medium for weaver, Small for spinner).
   *
   * @param {object} arm        — ArmUnit instance (must have getNetInventory, decrementNetInventory)
   * @param {number} armIndex   — arm array index
   * @param {object} launchPos  — world position {x, y, z} in metres
   * @param {object} launchDir  — normalised direction {x, y, z}
   * @param {object} target     — debris object
   * @param {string} [mode]     — 'SLAM_WRAP' or 'CINCH'
   * @returns {NetProjectile|null}
   */
  fireDaughterNet(arm, armIndex, launchPos, launchDir, target, mode) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return null;

    // Deploy state gate (C-4 integration)
    if (Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) {
      if (typeof arm.getDeployState === 'function' && arm.getDeployState() !== 'DEPLOYED') {
        return null;
      }
    }

    // Net inventory gate
    const inventory = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;
    if (inventory <= 0) return null;

    // Cooldown gate
    if (this._cooldownTimers.has(`arm_${armIndex}`)) return null;

    // Decrement inventory
    if (typeof arm.decrementNetInventory === 'function') {
      arm.decrementNetInventory();
    }

    const netClass = (arm.config?.type === 'weaver') ? CN.MEDIUM : CN.SMALL;

    // CEREMONY_REDESIGN §4 / NET_CEREMONY alignment (2026-05-25): see fireMotherNet
    // above for full rationale. Force CINCH so beats 5–6 visuals (ENVELOP, CINCH_CLOSING)
    // actually render during the ceremony — SLAM_WRAP path skips those states.
    let resolvedMode = mode || recommendCaptureMode(target);
    if (!mode && Constants.FEATURE_FLAGS.NET_CEREMONY) {
      resolvedMode = MODES.CINCH;
    }

    const net = new NetProjectile({
      netClass,
      armIndex,
      podIndex: -1,
      launchPosition: launchPos,
      launchDirection: launchDir,
      targetDebris:   target,
      captureMode:    resolvedMode,
      sourceArm:      arm,           // §3.5: retained for inventory restoration on miss
    });

    this.activeNets.push(net);

    const remaining = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;

    eventBus.emit(Events.NET_FIRED, {
      source:   'daughter',
      armIndex,
      netClass: netClass === CN.MEDIUM ? 'MEDIUM' : 'SMALL',
      remaining,
    });

    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex,
      remaining,
    });

    return net;
  }

  // ── Queries (ST-9.4e — HUD) ───────────────────────────────────────────

  /** Total mother pod net count (both pods combined). */
  getMotherNetCount() {
    return this._motherPodInventory[0] + this._motherPodInventory[1];
  }

  /** Inventory for a specific mother pod. */
  getMotherPodInventory(podIndex) {
    return this._motherPodInventory[podIndex] || 0;
  }

  /** Max capacity for a specific mother pod. */
  getMotherPodMax(podIndex) {
    return this._motherPodMax[podIndex] || 0;
  }

  /** Set mother pod inventory (persistence restore). */
  setMotherPodInventory(counts) {
    if (Array.isArray(counts)) {
      this._motherPodInventory = [counts[0] || 0, counts[1] || 0];
    }
  }

  /** Get the active net projectile for a given arm index (if any). */
  getActiveNetForArm(armIndex) {
    return this.activeNets.find(n => n.armIndex === armIndex) || null;
  }

  /** Get the active net projectile for a given mother pod (if any). */
  getActiveNetForPod(podIndex) {
    return this.activeNets.find(n => n.podIndex === podIndex) || null;
  }

  /**
   * Get captured mass currently on an arm's net (for CoM integration).
   * Returns netClass mass + debris mass when a net is captured/reeling.
   * @param {number} armIndex
   * @returns {number} mass in kg
   */
  getCapturedNetMass(armIndex) {
    const net = this.getActiveNetForArm(armIndex);
    if (!net) return 0;
    if (net.state === STATES.CAPTURED || net.state === STATES.REELING) {
      return net.capturedMass + (net.netClass.MASS || 0);
    }
    return 0;
  }

  /**
   * Check if an arm/pod is in cooldown.
   * @param {'arm'|'pod'} type
   * @param {number} index
   * @returns {number} remaining cooldown seconds (0 = ready)
   */
  getCooldown(type, index) {
    return this._cooldownTimers.get(`${type}_${index}`) || 0;
  }

  // ── Mercy Rule (§5.7) ─────────────────────────────────────────────────

  /** Whether the player has ever caused fragmentation. */
  get playerHasFragmented() { return this._playerHasFragmented; }
  set playerHasFragmented(v) { this._playerHasFragmented = !!v; }

  /**
   * Process a fragmentation event and apply (or waive) consequences.
   * Returns true if mercy rule was applied (first-time waiver).
   *
   * @param {string} debrisId
   * @param {number} fragmentCount
   * @returns {boolean} mercyApplied
   */
  handleFragmentation(debrisId, fragmentCount) {
    const mercyApplied = CN.FRAG_MERCY_FIRST_FREE && !this._playerHasFragmented;
    this._playerHasFragmented = true;

    eventBus.emit(Events.NET_FRAGMENTATION, {
      debrisId,
      fragmentCount,
      mercyApplied,
    });

    return mercyApplied;
  }

  // ── Persistence (ST-9.4d — inventory round-trip) ──────────────────────

  /**
   * Get serialisable state for PersistenceManager.
   * @returns {object}
   */
  getState() {
    return {
      motherPodInventory: [...this._motherPodInventory],
      playerHasFragmented: this._playerHasFragmented,
    };
  }

  /**
   * Restore state from PersistenceManager.
   * @param {object} state
   */
  restoreState(state) {
    if (!state) return;
    if (Array.isArray(state.motherPodInventory)) {
      this._motherPodInventory = [...state.motherPodInventory];
    }
    if (typeof state.playerHasFragmented === 'boolean') {
      this._playerHasFragmented = state.playerHasFragmented;
    }
    this._initialized = true;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §4  Singleton Export
// ═══════════════════════════════════════════════════════════════════════════

/** Singleton CaptureNetSystem instance. */
export const captureNetSystem = new CaptureNetSystem();
export default captureNetSystem;
