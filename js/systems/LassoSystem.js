/**
 * LassoSystem.js — Short-range magnetic/adhesive projectile for quick debris grabs.
 * SPACE key fires a lasso toward the nearest debris within range.
 * Auto-aim assist (±30° cone) makes first catches easy.
 * ST-2.4 → FIX-2.4a: Weighted capture net — spinning octagonal net with perimeter weights,
 *   tube tether, radial sparks on contact.
 * @module systems/LassoSystem
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';

/** 1 meter in scene units (1 unit = 100 km = 100000 m) */
const M = 0.00001;

/** Reusable Z-axis vector for quaternion math */
const _zAxis = new THREE.Vector3(0, 0, 1);

/** Reusable zero vector for reel-in lerp target */
const _zeroVec = new THREE.Vector3(0, 0, 0);

export class LassoSystem {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this.scene = scene;

        /** @type {boolean} Whether a lasso is currently in flight */
        this.active = false;

        /** @type {THREE.Vector3|null} Lasso projectile position */
        this.projectilePos = null;

        /** @type {THREE.Vector3|null} Lasso velocity */
        this.projectileVel = null;

        /** @type {object|null} Target debris (from getDebrisNear result) */
        this.target = null;

        /** @type {string|null} Target debris ID for live lookup */
        this._targetId = null;

        /** @type {THREE.Vector3|null} Live target scene position (updated each frame) */
        this._targetScenePos = null;

        /** @type {THREE.Vector3} Offset of projectile relative to player (local frame) */
        this._projOffset = new THREE.Vector3();

        /** @type {number} Flight timer */
        this.flightTimer = 0;

        /** @type {number} Max flight time before lasso retracts */
        this.maxFlightTime = Constants.LASSO_MAX_FLIGHT_TIME;

        /** @type {number} Cooldown between casts */
        this.cooldown = 0;

        /** @type {THREE.Mesh|null} Tether outer sheath mesh (dark, thick — coaxial) */
        this._tetherMesh = null;

        /** @type {THREE.Mesh|null} Tether inner core mesh (bright, thin — coaxial v2) */
        this._tetherCore = null;

        /** @type {number} Pulse bead phase (legacy — kept for reset compat) */
        this._pulsePhase = 0;

        /** @type {THREE.QuadraticBezierCurve3|null} Most recently built tether curve */
        this._tetherCurve = null;

        /** @type {THREE.Group|null} Capture net projectile group (FIX-2.4a — replaces bolas) */
        this._netGroup = null;

        /** @type {boolean} Reel-in phase */
        this._reelingIn = false;

        /** @type {number} Reel progress 0-1 */
        this._reelProgress = 0;

        /** @type {THREE.Vector3} Reel start offset from player (relative coords — orbit-safe) */
        this._reelStartOffset = new THREE.Vector3();

        // Phase 6: Visual feedback state
        /** @type {number} Running time for animations */
        this._time = 0;

        /** @type {THREE.Mesh|null} Muzzle flash */
        this._muzzleFlash = null;
        /** @type {number} Muzzle flash timer (seconds remaining) */
        this._muzzleFlashTimer = 0;

        /** @type {THREE.Mesh|null} Contact flash */
        this._contactFlash = null;
        /** @type {number} Contact flash timer */
        this._contactFlashTimer = 0;

        /** @type {number} Accumulated net spin angle (radians) */
        this._netSpinAngle = 0;

        /** @type {number} Number of curve sample points for tether */
        this._tetherSampleCount = Constants.NET_TETHER_SEGMENTS + 1;

        /** @type {number} Max cooldown duration (for UI reference) — driven by Constants */
        this.cooldownMax = Constants.LASSO_COOLDOWN_CATCH;

        /** @type {boolean} Whether the first-cast comms primer has been sent this session */
        this._firstCastPrimerSent = false;

        /** @type {number} UX-3 #7 — remaining web tether ammo */
        this._ammo = Constants.LASSO_AMMO_MAX;

        /** @type {number|null} Target id we last announced as "in lasso range",
         *  so the proactive prompt fires once per entry (not every frame). */
        this._inRangePromptId = null;

        // ── Gossamer particle trail state ──────────────────────────────────
        /** @type {THREE.Points|null} Particle system for gossamer silk trail */
        this._trailPoints = null;
        /** @type {Float32Array} Particle positions (x,y,z per particle) */
        this._trailPositions = null;
        /** @type {Float32Array} Particle alphas (1 per particle) */
        this._trailAlphas = null;
        /** @type {Float32Array} Particle birth times (1 per particle) */
        this._trailBirths = null;
        /** @type {Float32Array} Particle drift velocities (x,y,z per particle) */
        this._trailDrift = null;
        /** @type {number} Next particle slot index (ring buffer) */
        this._trailHead = 0;
        /** @type {number} Trail particle count */
        this._trailCount = 200;
        /** @type {number} Particle lifetime in seconds */
        this._trailLifetime = 1.0;
        /** @type {number} Emit accumulator */
        this._trailEmitAccum = 0;

        this._createVisuals();
    }

    /** Create capture net projectile group, tube tether, trail, and flash visuals */
    _createVisuals() {
        // ── FIX-2.4a: Weighted capture net group ─────────────────────────────
        this._netGroup = new THREE.Group();

        const segments = Constants.NET_SEGMENTS;
        const crossLines = Constants.NET_CROSS_LINES;
        const radius = Constants.NET_PERIMETER_RADIUS * M;

        // Build perimeter vertex positions (octagonal ring)
        const perimeterVerts = [];
        for (let i = 0; i < segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            perimeterVerts.push(new THREE.Vector3(
                Math.cos(angle) * radius,
                Math.sin(angle) * radius,
                0
            ));
        }

        // Build line segment pairs for LineSegments geometry
        const positions = [];

        // Perimeter edges (octagonal outline)
        for (let i = 0; i < segments; i++) {
            const a = perimeterVerts[i];
            const b = perimeterVerts[(i + 1) % segments];
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }

        // Cross-lines (diameters through center — mesh pattern)
        for (let i = 0; i < crossLines; i++) {
            const a = perimeterVerts[i];
            const b = perimeterVerts[(i + Math.floor(segments / 2)) % segments];
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }

        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const lineMat = new THREE.LineBasicMaterial({
            color: 0x88ffcc,
            transparent: true,
            opacity: 0,
        });
        const netLines = new THREE.LineSegments(lineGeo, lineMat);
        this._netGroup.add(netLines);

        // Perimeter weight spheres (keep net spread open during flight)
        const weightGeo = new THREE.SphereGeometry(Constants.NET_WEIGHT_RADIUS * M, 6, 6);
        for (let i = 0; i < Constants.NET_WEIGHT_COUNT; i++) {
            const weightMat = new THREE.MeshStandardMaterial({
                color: 0x444444,
                metalness: 0.8,
                roughness: 0.3,
                transparent: true,
                opacity: 0,
            });
            const weightMesh = new THREE.Mesh(weightGeo, weightMat);
            const angle = (i / Constants.NET_WEIGHT_COUNT) * Math.PI * 2;
            weightMesh.position.set(
                Math.cos(angle) * radius,
                Math.sin(angle) * radius,
                0
            );
            this._netGroup.add(weightMesh);
        }

        this._netGroup.visible = false;
        this.scene.add(this._netGroup);

        // ── Sprint 2 v2: COAXIAL TETHER + energy pulse bead ─────────────────
        // Dyneema look: ivory/cyan-white fibre, not arcade yellow.
        // Sheath (dark, thick) provides silhouette; inner core (bright, thin)
        // provides the luminous cable look; pulse bead travels on reel-in.
        // Sprint 2 v2c: Use QuadraticBezierCurve3 (NOT CatmullRomCurve3 with 3
        // points) — Catmull-Rom with only 3 control points EXTRAPOLATES past
        // its endpoints, causing the tether to visibly extend beyond the
        // mothership in the opposite direction of the net ("out the back" bug).
        // Quadratic Bezier is mathematically guaranteed to pass through only
        // its two endpoints, with the middle point acting as a pull (not anchor).
        const initCurve = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, M * 5),
            new THREE.Vector3(0, 0, M * 10),
        );

        // Outer sheath — dark, roughly fabric-like
        const sheathGeo = new THREE.TubeGeometry(
            initCurve,
            Constants.NET_TETHER_SEGMENTS,
            Constants.NET_TETHER_SHEATH_RADIUS * M,
            Constants.NET_TETHER_RADIAL_SEGMENTS,
            false
        );
        const sheathMat = new THREE.MeshStandardMaterial({
            color: 0x3a4452,        // muted slate (fibre sheath)
            metalness: 0.15,
            roughness: 0.95,
            transparent: true,
            opacity: 0,
        });
        this._tetherMesh = new THREE.Mesh(sheathGeo, sheathMat);
        this._tetherMesh.visible = false;
        this.scene.add(this._tetherMesh);

        const coreGeo = new THREE.TubeGeometry(
            initCurve,
            Constants.NET_TETHER_SEGMENTS,
            Constants.NET_TETHER_CORE_RADIUS * M,
            Constants.NET_TETHER_RADIAL_SEGMENTS,
            false
        );
        const coreMat = new THREE.MeshBasicMaterial({
            color: 0xddeeff,        // cool ivory
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: true,
            depthTest: true,
        });
        this._tetherCore = new THREE.Mesh(coreGeo, coreMat);
        this._tetherCore.visible = false;
        this.scene.add(this._tetherCore);

        // Markers removed in v2e — they confirmed anchor was going to wrong place

        // Energy pulse bead removed (Issue #6 — de-arcade tether visual)
        // Trail spheres removed (Issue #6 — de-arcade tether visual)

        // ── Phase 6: Muzzle flash — bright white sphere ────────────────────
        const flashGeo = new THREE.SphereGeometry(M * 10, 6, 6);
        const flashMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
        });
        this._muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
        this._muzzleFlash.visible = false;
        this.scene.add(this._muzzleFlash);

        // ── Phase 6: Contact flash — white/cyan ─────────────────────────────
        const contactGeo = new THREE.SphereGeometry(M * 12, 6, 6);
        const contactMat = new THREE.MeshBasicMaterial({
            color: 0x88ffff,
            transparent: true,
            opacity: 0,
        });
        this._contactFlash = new THREE.Mesh(contactGeo, contactMat);
        this._contactFlash.visible = false;
        this.scene.add(this._contactFlash);

        // ── Gossamer particle trail ──────────────────────────────────────────
        const N = this._trailCount;
        this._trailPositions = new Float32Array(N * 3);
        this._trailAlphas = new Float32Array(N);
        this._trailBirths = new Float32Array(N); // 0 = inactive
        this._trailDrift = new Float32Array(N * 3);

        const trailGeo = new THREE.BufferGeometry();
        trailGeo.setAttribute('position', new THREE.BufferAttribute(this._trailPositions, 3));
        trailGeo.setAttribute('alpha', new THREE.BufferAttribute(this._trailAlphas, 1));

        // Custom ShaderMaterial for per-particle alpha + additive glow
        const trailMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0.55, 0.95, 0.80) }, // cyan-green silk
                uSize:  { value: M * 18 },                            // particle screen size
            },
            vertexShader: `
                attribute float alpha;
                varying float vAlpha;
                uniform float uSize;
                void main() {
                    vAlpha = alpha;
                    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = uSize * (300.0 / -mvPos.z);
                    gl_Position = projectionMatrix * mvPos;
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;
                void main() {
                    // Soft circular falloff
                    float d = length(gl_PointCoord - 0.5) * 2.0;
                    float falloff = 1.0 - smoothstep(0.0, 1.0, d);
                    gl_FragColor = vec4(uColor, vAlpha * falloff * 0.7);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });

        this._trailPoints = new THREE.Points(trailGeo, trailMat);
        this._trailPoints.frustumCulled = false;
        this._trailPoints.visible = false;
        this.scene.add(this._trailPoints);

        // NOTE: Contact ring removed (ST-2.4) — replaced by dynamic radial sparks
    }

    /**
     * Set opacity on all net group children materials (Mesh + LineSegments).
     * @param {number} opacity
     */
    _setNetOpacity(opacity) {
        if (!this._netGroup) return;
        this._netGroup.traverse(child => {
            if (child.material) {
                child.material.opacity = opacity;
            }
        });
    }

    // Sparks removed per user feedback — "NOT an arcade game"

    /**
     * Rebuild coaxial tether (sheath + core) with a subtle catenary sag at
     * the midpoint for natural cable-slack look. Stores the curve so the
     * pulse bead can travel along it during reel-in.
     * Sag magnitude scales with tether length so short tethers stay taut.
     * @param {THREE.Vector3} startPos - Satellite attach point
     * @param {THREE.Vector3} endPos   - Net projectile position
     */
    _rebuildTetherGeometry(startPos, endPos) {
        if (!this._tetherMesh) return;

        const length = startPos.distanceTo(endPos);
        // Sag capped at either the configured NET_TETHER_SAG (m) or 5% of length,
        // whichever is smaller — short tethers stay visually taut.
        const sagMag = Math.min(Constants.NET_TETHER_SAG * M, length * 0.05);
        const mid = new THREE.Vector3()
            .addVectors(startPos, endPos)
            .multiplyScalar(0.5);
        // Catenary sag: bias midpoint toward -Y. For a QuadraticBezierCurve3,
        // the control point pulls the curve TOWARD it (but never reaches it).
        // To achieve sag amount `s` at the apex, the control point must be at
        // 2s below the midpoint (since the apex of a symmetric quadratic bezier
        // sits at 50% of the way from line to control point).
        mid.y -= sagMag * 2;

        // Sprint 2 v2c: QuadraticBezierCurve3 — guaranteed no extrapolation
        // past endpoints. CatmullRomCurve3 with 3 points OVERSHOOTS past
        // start/end, causing the "tether out the back of mother" bug.
        const curve = new THREE.QuadraticBezierCurve3(
            startPos.clone(),
            mid,
            endPos.clone()
        );
        this._tetherCurve = curve;

        // Sheath (outer, thick, dark)
        const sheathGeo = new THREE.TubeGeometry(
            curve,
            Constants.NET_TETHER_SEGMENTS,
            Constants.NET_TETHER_SHEATH_RADIUS * M,
            Constants.NET_TETHER_RADIAL_SEGMENTS,
            false
        );
        this._tetherMesh.geometry.dispose();
        this._tetherMesh.geometry = sheathGeo;

        // Core (inner, thin, bright) — coaxial
        if (this._tetherCore) {
            const coreGeo = new THREE.TubeGeometry(
                curve,
                Constants.NET_TETHER_SEGMENTS,
                Constants.NET_TETHER_CORE_RADIUS * M,
                Constants.NET_TETHER_RADIAL_SEGMENTS,
                false
            );
            this._tetherCore.geometry.dispose();
            this._tetherCore.geometry = coreGeo;
        }
    }

    /**
     * Extract scene position from a debris object returned by getDebrisNear.
     * getDebrisNear returns objects with _cartesian.position = { x, y, z }.
     * @param {object} debris
     * @returns {THREE.Vector3|null}
     */
    _getDebrisScenePos(debris) {
        if (!debris) return null;
        // Original debris objects have _scenePosition (from DebrisField._updateInstanceTransform)
        if (debris._scenePosition) {
            return debris._scenePosition.clone();
        }
        // Copies from getDebrisNear() have _cartesian
        if (debris._cartesian && debris._cartesian.position) {
            const p = debris._cartesian.position;
            return new THREE.Vector3(p.x, p.y, p.z);
        }
        return null;
    }

    /**
     * Proactive in-range prompt (gap C.3). When the Tab-selected target first
     * comes within lasso range AND a cast is actually possible, emit a one-time
     * "press N" comms hint. Resets when the target leaves range / changes / a
     * cast becomes impossible, so it re-arms for the next entry.
     * @private
     * @param {THREE.Vector3} playerPos
     * @param {object|null} selectedTarget
     */
    _updateInRangePrompt(playerPos, selectedTarget) {
        // A cast must be currently possible, else clear and bail.
        const canCast = !this.active && this.cooldown <= 0 && this._ammo > 0;
        if (!canCast || !selectedTarget || !playerPos) {
            this._inRangePromptId = null;
            return;
        }

        const targetId = selectedTarget.id != null ? selectedTarget.id : selectedTarget.catalogId;
        const pos = this._getDebrisScenePos(selectedTarget);
        if (!pos) { this._inRangePromptId = null; return; }

        const inRange = playerPos.distanceTo(pos) <= Constants.LASSO_RANGE * M;
        const tooHeavy = (selectedTarget.mass || 1) > Constants.LASSO_MAX_CAPTURE_MASS;

        if (inRange && !tooHeavy) {
            // Only announce on the transition into range for this target.
            if (this._inRangePromptId !== targetId) {
                this._inRangePromptId = targetId;
                eventBus.emit(Events.COMMS_MESSAGE, {
                    text: 'Target in lasso range — press N to cast.',
                    source: 'SYSTEM',
                    channel: 'CMD',
                    priority: 'info',
                    _lassoFeedback: true,
                });
            }
        } else {
            // Out of range, too heavy, or deselected — re-arm for next entry.
            this._inRangePromptId = null;
        }
    }

    /**
     * Fire a lasso toward the nearest debris.
     * @param {THREE.Vector3} playerPos - Mothership position
     * @param {object} debrisField - DebrisField instance
     * @param {THREE.Vector3} [playerVelDir] - Prograde direction for aim cone
     * @param {object|null} [selectedTarget=null] - Tab-selected target from TargetSelector (priority over auto-aim)
     * @returns {boolean} true if lasso was fired
     */
    fire(playerPos, debrisField, playerVelDir, selectedTarget = null) {
        if (this.active || this.cooldown > 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'cooldown' });
            // UX: tell the player WHY the cast was rejected. Without this the
            // only feedback is a red reticle flash + click — a first-time
            // player can't tell the lasso is mid-flight or recharging.
            const secs = this.cooldownRemaining;
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: this.active
                    ? 'Lasso busy — wait for it to retract'
                    : `Lasso recharging — ${Math.ceil(secs)}s`,
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'info',
                _lassoFeedback: true,
            });
            return false;
        }

        // UX-3 #7: Ammo check
        if (this._ammo <= 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'no_ammo' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Web tether depleted — deploy Crossbow arms [D]',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
                _lassoFeedback: true,
            });
            return false;
        }

        // Find nearest debris within lasso range
        const rangeScene = Constants.LASSO_RANGE * M; // 200m in scene units
        const nearby = debrisField.getDebrisNear(playerPos, rangeScene);

        if (!nearby || nearby.length === 0) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'no_target' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'No targets in lasso range (200m)',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'info',
                _lassoFeedback: true,
            });
            return false;
        }

        // Auto-aim: find closest target within ±30° cone of prograde
        let bestTarget = null;
        let bestPos = null;
        let bestDist = Infinity;

        // PRIORITY 1: If player has Tab-selected a target and it's in range, use it (S1 Fix C2)
        if (selectedTarget) {
            const selectedPos = this._getDebrisScenePos(selectedTarget);
            if (selectedPos) {
                const dist = playerPos.distanceTo(selectedPos);
                const mass = selectedTarget.mass || 1;
                // UX-3 #4: Mass-specific rejection with comms hint
                if (mass > Constants.LASSO_MAX_CAPTURE_MASS) {
                    eventBus.emit(Events.LASSO_DENIED, { reason: 'too_heavy' });
                    eventBus.emit(Events.COMMS_MESSAGE, {
                        text: 'Target too massive for Mother net. Try deploying a Daughter [D]',
                        source: 'SYSTEM',
                        channel: 'CMD',
                        priority: 'warning',
                        _lassoFeedback: true,
                    });
                    return false;
                }
                if (dist <= rangeScene) {
                    bestTarget = selectedTarget;
                    bestPos = selectedPos;
                    bestDist = dist;
                }
            }
        }

        // PRIORITY 2: Fall back to auto-aim only if no selected target in range
        const aimDir = playerVelDir
            ? playerVelDir.clone().normalize()
            : new THREE.Vector3(0, 0, 1);
        const maxAngle = 30 * Math.PI / 180; // ±30° cone

        if (!bestTarget) for (const d of nearby) {
            const debrisPos = this._getDebrisScenePos(d);
            if (!debrisPos) continue;

            const toDebris = new THREE.Vector3().subVectors(debrisPos, playerPos);
            const dist = toDebris.length();
            toDebris.normalize();

            const dot = Math.max(-1, Math.min(1, toDebris.dot(aimDir)));
            const angle = Math.acos(dot);

            // Check mass limit
            const mass = d.mass || 1;
            if (mass > Constants.LASSO_MAX_CAPTURE_MASS) continue;

            if (angle <= maxAngle && dist < bestDist) {
                bestDist = dist;
                bestTarget = d;
                bestPos = debrisPos;
            }
        }

        // Fallback: if no target in cone, grab the absolute nearest eligible target
        if (!bestTarget) {
            for (const d of nearby) {
                const mass = d.mass || 1;
                if (mass > Constants.LASSO_MAX_CAPTURE_MASS) continue;
                const debrisPos = this._getDebrisScenePos(d);
                if (!debrisPos) continue;
                bestTarget = d;
                bestPos = debrisPos;
                break; // already sorted by distance from getDebrisNear
            }
        }

        if (!bestTarget || !bestPos) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'no_target' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'No suitable target for lasso (too heavy or no position)',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'info',
                _lassoFeedback: true,
            });
            return false;
        }

        // UX-3 #4: Forward-arc constraint — target must be in forward hemisphere
        const fwdDir = playerVelDir
            ? playerVelDir.clone().normalize()
            : new THREE.Vector3(0, 0, 1);
        const toTarget = new THREE.Vector3().subVectors(bestPos, playerPos).normalize();
        const fwdDot = toTarget.dot(fwdDir);
        if (fwdDot < Constants.LASSO_FORWARD_ARC_DOT) {
            eventBus.emit(Events.LASSO_DENIED, { reason: 'outside_arc' });
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Target not in forward arc — align with autopilot first',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
                _lassoFeedback: true,
            });
            return false;
        }

        // Fire!
        this.active = true;
        this.target = bestTarget;
        this._targetId = bestTarget.id;
        this._targetScenePos = bestPos.clone();
        this.projectilePos = playerPos.clone();
        this._projOffset.set(0, 0, 0); // starts at player

        const dir = new THREE.Vector3().subVectors(bestPos, playerPos).normalize();
        this.projectileVel = dir.multiplyScalar(Constants.LASSO_SPEED * M); // LASSO_SPEED m/s in scene units (relative)

        this.flightTimer = 0;
        this._reelingIn = false;
        this._reelProgress = 0;
        this._netSpinAngle = 0;

        // Show capture net visuals (FIX-2.4a) — reset scale in case prior reel-in collapsed it
        this._netGroup.visible = true;
        this._netGroup.scale.setScalar(1.0);
        this._setNetOpacity(0.8);
        // Sprint 2 v2: Show coaxial tether (sheath + bright core)
        this._tetherMesh.visible = true;
        this._tetherMesh.material.opacity = 0.55;
        if (this._tetherCore) {
            this._tetherCore.visible = true;
            this._tetherCore.material.opacity = 0.8;
        }
        this._pulsePhase = 0;
        this._muzzleFlashTimer = 0;
        this._muzzleFlash.visible = false;

        // Sound: electromagnetic THWIP (via EventBus → AudioSystem)
        eventBus.emit(Events.LASSO_FIRED, {
            targetId: bestTarget.id,
            projectileMass: Constants.LASSO_PROJECTILE_MASS,
            launchDirection: this.projectileVel.clone().normalize(),
            speed: Constants.LASSO_SPEED,
        });

        // ST-1.3: First-cast comms primer — once per session
        if (!this._firstCastPrimerSent) {
            this._firstCastPrimerSent = true;
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Lasso deployed — hold steady for catch. Recharges from onboard power.',
                priority: 'info',
            });
        }

        // UX-3 #7: Decrement ammo + emit change event
        this._ammo--;
        eventBus.emit(Events.LASSO_AMMO_CHANGED, {
            remaining: this._ammo,
            max: Constants.LASSO_AMMO_MAX,
        });

        // UX-3 #7: Low ammo warning at 5 remaining
        if (this._ammo === 5) {
            eventBus.emit(Events.COMMS_MESSAGE, {
                text: 'Web nets running low — Crossbow arms are reusable',
                source: 'SYSTEM',
                channel: 'CMD',
                priority: 'warning',
            });
        }

        return true;
    }

    /**
     * UX-3 #7: Refill web tether ammo to max (called by shop purchase).
     */
    refillAmmo() {
        this._ammo = Constants.LASSO_AMMO_MAX;
        eventBus.emit(Events.LASSO_AMMO_CHANGED, {
            remaining: this._ammo,
            max: Constants.LASSO_AMMO_MAX,
        });
    }

    /**
     * Get current ammo count (for HUD queries).
     * @returns {number}
     */
    getAmmo() {
        return this._ammo;
    }

    /**
     * Look up the live scene position of the target debris from its orbital elements.
     * @param {object} debrisField
     * @returns {THREE.Vector3|null}
     */
    _getLiveTargetPos(debrisField) {
        // FIX: use `== null` so targetId === 0 (valid — first debris spawned) is NOT
        // treated as "target died", which previously cancelled the lasso on frame 1.
        if (this._targetId == null || !debrisField) return null;
        const debris = debrisField.getDebrisById
            ? debrisField.getDebrisById(this._targetId)
            : null;
        if (!debris || !debris.alive || !debris.orbit) return null;
        const cart = orbitToSceneCartesian(debris.orbit);
        return new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z);
    }

    /**
     * Update lasso state each frame.
     * @param {number} dt - Delta time
     * @param {THREE.Vector3} playerPos - Current mothership position
     * @param {object} debrisField - For debris removal on catch
     */
    update(dt, playerPos, debrisField, selectedTarget = null) {
        this._time += dt;

        if (this.cooldown > 0) {
            this.cooldown -= dt;
            if (this.cooldown <= 0) {
                this.cooldown = 0;
                eventBus.emit(Events.LASSO_COOLDOWN_END, {});
            }
        }

        // Phase 6: Update visual effects (run independently of active state)
        this._updateVisualEffects(dt);

        // Proactive "in range — press N" prompt (gap C.3). Fires once when the
        // Tab-selected target first enters lasso range while a cast is possible
        // (idle, off cooldown, ammo available, target light enough).
        this._updateInRangePrompt(playerPos, selectedTarget);

        if (!this.active) return;


        this.flightTimer += dt;

        // --- Refresh target position from orbital elements each frame ---
        const liveTargetPos = this._getLiveTargetPos(debrisField);
        if (liveTargetPos) {
            this._targetScenePos.copy(liveTargetPos);
        } else if (!this._reelingIn) {
            // Target died or became invalid during flight
            this._cancelLasso();
            return;
        }

        if (this._reelingIn) {
            // Reel-in phase: move debris toward player
            this._reelProgress += dt * Constants.LASSO_REEL_SPEED;
            this._reelProgress = Math.min(this._reelProgress, 1.0); // clamp — prevent overshoot
            if (this._reelProgress >= 1.0) {
                // Catch complete!
                this._completeCatch(debrisField);
                return;
            }

            // S4: Emit tether tension feedback — intensifies as reel-in progresses
            eventBus.emit(Events.TETHER_TENSION, {
                tensionFraction: this._reelProgress,
                armId: 'lasso',
            });

            // Two-phase capture: WRAP (net shrinks at contact) → REEL (compact package
            // travels to player). Matches physically meaningful net capture sequence.
            const WRAP_END = 0.2;                              // wrap phase: t ∈ [0, 0.2]
            const COMPACT_SCALE = Constants.NET_COMPACT_SCALE; // Sprint 2 v2: 0.45 (was 0.15 — too small to see)

            if (this._netGroup) this._netGroup.scale.setScalar(
                this._reelProgress < WRAP_END
                    ? 1.0 - (this._reelProgress / WRAP_END) * (1.0 - COMPACT_SCALE)
                    : COMPACT_SCALE
            );
            this._setNetOpacity(0.8);
            // Tether hidden at contact — no opacity update needed during reel-in

            let reelT;
            if (this._reelProgress < WRAP_END) {
                // WRAP: net stays at contact position while shrinking
                reelT = 0;
            } else {
                // REEL: compact package travels player-relative from contact → zero
                reelT = (this._reelProgress - WRAP_END) / (1 - WRAP_END);
            }
            const reelOffset = new THREE.Vector3().lerpVectors(
                this._reelStartOffset, _zeroVec, reelT
            );
            this.projectilePos.copy(playerPos).add(reelOffset);
        } else {
            // Flight phase: homing projectile tracks target in local frame
            // Advance offset toward target-relative-to-player
            const targetOffset = new THREE.Vector3().subVectors(this._targetScenePos, playerPos);
            const toTarget = new THREE.Vector3().subVectors(targetOffset, this._projOffset);
            const distToTarget = toTarget.length();

            if (distToTarget < M * 20) { // within 20m — contact!
                this._reelingIn = true;
                // CRITICAL FIX (v2e): Use _projOffset directly — it's already the
                // player-relative offset, uncontaminated by per-frame orbital drift.
                // Previous code (subVectors(projectilePos, playerPos)) was subtracting
                // playerPos_N from projectilePos_{N-1}, introducing a velocity×dt
                // error of ~1.3km per frame. At 80km/s apparent orbital velocity
                // that error FLIPS the offset sign, causing the net to reel in
                // from ~1.3km BEHIND the ship ("shoots out front, disappears,
                // reels in from the back").
                this._reelStartOffset.copy(this._projOffset);
                this._reelProgress = 0;

                // Contact flash removed per user feedback ("NOT an arcade game")
                this._contactFlashTimer = 0;
                this._contactFlash.visible = false;

                // Sprint 2 v2: KEEP tether visible through reel-in — this is the
                // visual cue that tells the player their debris is being retracted.
                // Retrograde-cast bug is avoided because _rebuildTetherGeometry
                // rebuilds from current playerPos → projectilePos every frame.


                eventBus.emit(Events.LASSO_CONTACT, { targetId: this.target.id });
            } else {
                // Move projectile toward current target at lasso speed (relative frame)
                // Multiply by TIME_SCALE_GAMEPLAY so the lasso travels at real game speed, not slow real-time speed
                const speed = Constants.LASSO_SPEED * M; // m/s → scene units
                const step = Math.min(speed * dt * Constants.TIME_SCALE_GAMEPLAY, distToTarget);
                toTarget.normalize().multiplyScalar(step);
                this._projOffset.add(toTarget);
            }

            // Convert offset back to absolute scene position
            this.projectilePos.copy(playerPos).add(this._projOffset);

            // Timeout
            if (this.flightTimer > this.maxFlightTime) {
                this._cancelLasso();
                return;
            }
        }

        // ── Gossamer particle trail: emit + update ────────────────────────────
        this._updateGossamerTrail(dt, playerPos);

        // ── FIX-2.4a: Update net position, orientation, and spin ─────────────
        if (this._netGroup && this.projectilePos) {
            this._netGroup.position.copy(this.projectilePos);

            // Orient net face perpendicular to flight direction (Z-axis = velocity)
            if (this._targetScenePos && !this._reelingIn) {
                const flightDir = new THREE.Vector3()
                    .subVectors(this._targetScenePos, playerPos).normalize();
                if (flightDir.lengthSq() > 0.001) {
                    const orientQuat = new THREE.Quaternion();
                    orientQuat.setFromUnitVectors(_zAxis, flightDir);
                    // Apply gyroscopic spin around flight axis
                    this._netSpinAngle += 2 * Math.PI * Constants.NET_SPIN_HZ * dt;
                    const spinQuat = new THREE.Quaternion();
                    spinQuat.setFromAxisAngle(_zAxis, this._netSpinAngle);
                    this._netGroup.quaternion.multiplyQuaternions(orientQuat, spinQuat);
                }
            } else {
                // During reel-in, just spin in place
                this._netSpinAngle += 2 * Math.PI * Constants.NET_SPIN_HZ * dt;
                this._netGroup.rotation.z = this._netSpinAngle;
            }
        }

        // Sprint 2 v2e: Rebuild tether EVERY frame from PLAYER CENTRE → projectile.
        // No bow offset — keeps it simple. Combined with QuadraticBezierCurve3
        // (no extrapolation) the tether is guaranteed to go from ship centre to
        // the net and nowhere else.
        if (this._tetherMesh && this._tetherMesh.visible && this.projectilePos) {
            this._tetherMesh.material.opacity = 0.5;
            if (this._tetherCore) {
                this._tetherCore.material.opacity = this._reelingIn ? 0.95 : 0.8;
            }
            this._rebuildTetherGeometry(playerPos, this.projectilePos);
        }

        // Energy pulse bead removed (Issue #6 — de-arcade tether visual)
    }

    /** Complete a successful lasso catch */
    _completeCatch(debrisField) {
        const target = this.target;

        // Remove debris from field
        if (debrisField && target) {
            debrisField.removeDebris(target.id);
        }

        // Emit lasso-specific catch event (TutorialSystem listens to this)
        eventBus.emit(Events.LASSO_CAPTURED, {
            debrisId: target ? target.id : null,
            type: target ? target.type : 'unknown',
            mass: target ? (target.mass || 0) : 0,
        });

        // Also emit ARM_CAPTURED for catch juice (slo-mo, flash, sound)
        eventBus.emit(Events.ARM_CAPTURED, {
            armId: 'lasso',
            debrisId: target ? target.id : null,
        });

        // Score the lasso catch through the normal pipeline
        eventBus.emit(Events.INTERACTION_CAPTURE, {
            points: Constants.TIER3_BASE || 500,
            type: target ? target.type : 'fragment',
        });

        // Record score in ScoringSystem (INTERACTION_CAPTURE only updates gameState)
        eventBus.emit(Events.SCORING_AWARD, {
            points: Constants.TIER3_BASE || 500,
            debris: target || { type: 'fragment', mass: 1 },
            method: 'arm',
            captureTier: 3,
        });

        // Comms
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: `Lasso catch! ${target ? target.type : 'debris'} secured.`,
            priority: 'info',
        });

        this._resetLasso();
        this.cooldown = Constants.LASSO_COOLDOWN_CATCH;
        this.cooldownMax = Constants.LASSO_COOLDOWN_CATCH;
        eventBus.emit(Events.LASSO_COOLDOWN_START, { duration: Constants.LASSO_COOLDOWN_CATCH });
    }

    /**
     * Update gossamer silk particle trail — emit at projectile, update drift + fade.
     * @param {number} dt
     * @param {THREE.Vector3} playerPos
     * @private
     */
    _updateGossamerTrail(dt, playerPos) {
        if (!this._trailPoints) return;

        const N = this._trailCount;
        const pos = this._trailPositions;
        const alphas = this._trailAlphas;
        const births = this._trailBirths;
        const drift = this._trailDrift;
        const now = this._time;
        const lifetime = this._trailLifetime;

        // ── Emit new particles during flight (not reel-in) ────────────────
        if (this.active && this.projectilePos && !this._reelingIn) {
            this._trailPoints.visible = true;
            // Emit ~60 particles/sec (1 per ~0.016s)
            this._trailEmitAccum += dt;
            const emitInterval = 0.016;
            while (this._trailEmitAccum >= emitInterval) {
                this._trailEmitAccum -= emitInterval;
                const i = this._trailHead;
                const i3 = i * 3;

                // Position at projectile with small random offset
                pos[i3]     = this.projectilePos.x + (Math.random() - 0.5) * M * 3;
                pos[i3 + 1] = this.projectilePos.y + (Math.random() - 0.5) * M * 3;
                pos[i3 + 2] = this.projectilePos.z + (Math.random() - 0.5) * M * 3;

                // Curl-noise-like drift: random perpendicular velocity
                const driftSpeed = M * 0.5; // very slow lateral drift
                drift[i3]     = (Math.random() - 0.5) * driftSpeed;
                drift[i3 + 1] = (Math.random() - 0.5) * driftSpeed;
                drift[i3 + 2] = (Math.random() - 0.5) * driftSpeed;

                births[i] = now;
                alphas[i] = 1.0;

                this._trailHead = (i + 1) % N;
            }
        }

        // ── Update all particles: drift + fade ────────────────────────────
        let anyAlive = false;
        for (let i = 0; i < N; i++) {
            if (births[i] <= 0) continue; // inactive slot
            const age = now - births[i];
            if (age > lifetime) {
                // Dead — hide particle
                alphas[i] = 0;
                births[i] = 0;
                continue;
            }
            anyAlive = true;

            // Smooth fade: ease-out (fast at start, slow tail)
            const t = age / lifetime;
            alphas[i] = 1.0 - t * t; // quadratic fade-out

            // Drift with curl-like sinusoidal modulation
            const i3 = i * 3;
            const curlPhase = age * 4.0 + i * 0.7; // unique per particle
            pos[i3]     += drift[i3]     * dt + Math.sin(curlPhase) * M * 0.02 * dt;
            pos[i3 + 1] += drift[i3 + 1] * dt + Math.cos(curlPhase * 1.3) * M * 0.02 * dt;
            pos[i3 + 2] += drift[i3 + 2] * dt + Math.sin(curlPhase * 0.7) * M * 0.02 * dt;
        }

        // Update GPU buffers
        if (this._trailPoints.visible) {
            this._trailPoints.geometry.attributes.position.needsUpdate = true;
            this._trailPoints.geometry.attributes.alpha.needsUpdate = true;
        }

        // Hide trail when all particles dead and lasso inactive
        if (!this.active && !anyAlive) {
            this._trailPoints.visible = false;
        }
    }

    /** Cancel/retract lasso without a catch */
    _cancelLasso() {
        eventBus.emit(Events.LASSO_MISSED);  // notify tutorial of mid-flight miss
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'Lasso retracted — no contact.',
            priority: 'info',
        });
        this._resetLasso();
        this.cooldown = Constants.LASSO_COOLDOWN_MISS;
        this.cooldownMax = Constants.LASSO_COOLDOWN_MISS;
        eventBus.emit(Events.LASSO_COOLDOWN_START, { duration: Constants.LASSO_COOLDOWN_MISS });
    }

    /** Reset lasso state */
    _resetLasso() {
        this.active = false;
        this.target = null;
        this._targetId = null;
        this._targetScenePos = null;
        this._projOffset.set(0, 0, 0);
        this.projectilePos = null;
        this.projectileVel = null;
        this.flightTimer = 0;
        this._reelingIn = false;
        this._reelProgress = 0;
        this._netSpinAngle = 0;

        if (this._netGroup) this._netGroup.visible = false;
        if (this._tetherMesh) {
            this._tetherMesh.visible = false;
            this._tetherMesh.material.opacity = 0;
        }
        if (this._tetherCore) {
            this._tetherCore.visible = false;
            this._tetherCore.material.opacity = 0;
        }
        this._pulsePhase = 0;
        this._tetherCurve = null;
    }

    /**
     * Phase 6 + ST-2.4: Update visual effects independently of lasso active state.
     * Allows muzzle flash, contact flash, and sparks to persist briefly after reset.
     * @param {number} dt
     */
    _updateVisualEffects(dt) {
        // Muzzle flash fade (200ms)
        if (this._muzzleFlashTimer > 0) {
            this._muzzleFlashTimer -= dt;
            this._muzzleFlash.material.opacity = Math.max(0, this._muzzleFlashTimer / 0.2) * 0.9;
            if (this._muzzleFlashTimer <= 0) {
                this._muzzleFlash.visible = false;
            }
        }

        // Contact flash fade (300ms)
        if (this._contactFlashTimer > 0) {
            this._contactFlashTimer -= dt;
            this._contactFlash.material.opacity = Math.max(0, this._contactFlashTimer / 0.3) * 0.9;
            if (this._contactFlashTimer <= 0) {
                this._contactFlash.visible = false;
            }
        }

        // Sparks removed per user feedback
    }

    // ── Public cooldown state accessors (ST-1.3) ────────────────────────────

    /** Seconds of cooldown remaining (0 = ready to fire) */
    get cooldownRemaining() {
        return Math.max(0, this.cooldown);
    }

    /** Fraction of cooldown elapsed: 0 = just started, 1 = ready (for ring UI) */
    get cooldownFraction() {
        if (this.cooldownMax <= 0 || this.cooldown <= 0) return 1;
        return 1 - (this.cooldown / this.cooldownMax);
    }

    /** Cleanup */
    dispose() {
        // FIX-2.4a: Dispose capture net group
        if (this._netGroup) {
            this._netGroup.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
            this.scene.remove(this._netGroup);
        }
        // Sprint 2 v2: Dispose coaxial tether (sheath + core)
        if (this._tetherMesh) {
            this.scene.remove(this._tetherMesh);
            this._tetherMesh.geometry.dispose();
            this._tetherMesh.material.dispose();
        }
        if (this._tetherCore) {
            this.scene.remove(this._tetherCore);
            this._tetherCore.geometry.dispose();
            this._tetherCore.material.dispose();
        }
        // Gossamer trail cleanup
        if (this._trailPoints) {
            this.scene.remove(this._trailPoints);
            this._trailPoints.geometry.dispose();
            this._trailPoints.material.dispose();
        }
        // Sparks removed — no cleanup needed
        if (this._muzzleFlash) {
            this.scene.remove(this._muzzleFlash);
            this._muzzleFlash.geometry.dispose();
            this._muzzleFlash.material.dispose();
        }
        if (this._contactFlash) {
            this.scene.remove(this._contactFlash);
            this._contactFlash.geometry.dispose();
            this._contactFlash.material.dispose();
        }
    }
}
