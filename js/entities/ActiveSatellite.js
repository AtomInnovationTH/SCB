/**
 * ActiveSatellite.js — Active (operational) satellites that must be avoided
 * Collision with any of these is GAME OVER.
 * @module entities/ActiveSatellite
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import {
  propagateOrbit,
  orbitToSceneCartesian,
  kmToScene,
} from './OrbitalMechanics.js';

// ============================================================================
// CONSTELLATION DEFINITIONS
// ============================================================================

/** Predefined active satellite constellations / notable sats */
const ACTIVE_SAT_TEMPLATES = [
  // ISS
  {
    name: 'ISS',
    altKm: 420, inc: 51.6, count: 1,
    size: 0.0001, // ~10m scale in scene
    color: 0xffffee,
  },
  // Starlink shells
  {
    name: 'Starlink',
    altKm: 550, inc: 53.0, count: 12,
    size: 0.00003,
    color: 0xeeeeff,
  },
  // Sun-synchronous weather sats
  {
    name: 'WeatherSat',
    altKm: 800, inc: 97.4, count: 6,
    size: 0.00004,
    color: 0xffddaa,
  },
  // GPS-like (medium orbit, high altitude)
  {
    name: 'NavSat',
    altKm: 1200, inc: 55.0, count: 4,
    size: 0.00003,
    color: 0xaaddff,
  },
  // Russian reconnaissance
  {
    name: 'ReconSat',
    altKm: 500, inc: 65.0, count: 3,
    size: 0.00003,
    color: 0xffaaaa,
  },
  // SSO Earth observation
  {
    name: 'EarthObs',
    altKm: 700, inc: 98.2, count: 5,
    size: 0.00004,
    color: 0xaaffaa,
  },
  // Random operational sats
  {
    name: 'OpSat',
    altKm: 450, inc: 28.5, count: 4,
    size: 0.00003,
    color: 0xddddff,
  },
  {
    name: 'OpSat2',
    altKm: 600, inc: 72.0, count: 3,
    size: 0.00003,
    color: 0xffddff,
  },
];

export class ActiveSatellites {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.satellites = [];   // Array of satellite data objects
    this.group = new THREE.Group();
    this.group.name = 'ActiveSatellites';
    scene.add(this.group);

    this._blinkTimer = 0;
    this._blinkState = false;

    // Pre-allocated temporaries for update() hot loop
    this._tmpVelDir = new THREE.Vector3();
    this._tmpRadial = new THREE.Vector3();
    this._tmpMat4 = new THREE.Matrix4();
    this._tmpTarget = new THREE.Vector3();
    this._tmpKmOrbit = {
      semiMajorAxis: 0, eccentricity: 0, inclination: 0,
      raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0,
    };

    this._generate();
  }

  // ==========================================================================
  // GENERATION
  // ==========================================================================

  /** @private */
  _generate() {
    let id = 0;

    for (const template of ACTIVE_SAT_TEMPLATES) {
      for (let i = 0; i < template.count; i++) {
        const sat = this._createSatellite(id++, template, i);
        this.satellites.push(sat);
      }
    }

    console.log(`[ActiveSatellites] Generated ${this.satellites.length} active satellites`);
  }

  /**
   * Create a single active satellite.
   * @private
   */
  _createSatellite(id, template, index) {
    const altScene = template.altKm * Constants.SCENE_SCALE;
    const sma = Constants.EARTH_RADIUS + altScene;

    // Spread satellites around the orbit with different RAAN and true anomaly
    const raanSpread = (2 * Math.PI / template.count) * index + Math.random() * 0.5;
    const taSpread = Math.random() * 2 * Math.PI;

    const orbit = {
      semiMajorAxis: sma,
      eccentricity: 0.0005 + Math.random() * 0.001,
      inclination: (template.inc + (Math.random() - 0.5) * 0.5) * Math.PI / 180,
      raan: raanSpread,
      argPerigee: Math.random() * 2 * Math.PI,
      trueAnomaly: taSpread,
      meanMotion: 0,
    };

    // Visual model — simple but distinct from debris
    const mesh = this._buildSatMesh(template);
    this.group.add(mesh);

    // Blinking strobe light
    const strobeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const strobeGeo = new THREE.SphereGeometry(template.size * 0.3, 4, 4);
    const strobe = new THREE.Mesh(strobeGeo, strobeMat);
    strobe.position.set(0, template.size * 0.6, 0);
    mesh.add(strobe);

    return {
      id,
      name: `${template.name}-${index}`,
      orbit,
      mesh,
      strobe,
      size: template.size,
      collisionRadius: template.size * 2, // Generous collision zone
      template,
    };
  }

  /**
   * Build a mesh for an active satellite — visually distinct from debris.
   * @private
   */
  _buildSatMesh(template) {
    const group = new THREE.Group();
    const s = template.size;

    // Main body
    const bodyGeo = new THREE.BoxGeometry(s * 0.5, s * 0.3, s * 0.7);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: template.color,
      metalness: 0.6,
      roughness: 0.4,
      emissive: template.color,
      emissiveIntensity: 0.1,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(body);

    // Solar panel wings
    const panelGeo = new THREE.PlaneGeometry(s * 1.2, s * 0.4);
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x112244,
      metalness: 0.3,
      roughness: 0.5,
      side: THREE.DoubleSide,
      emissive: 0x050515,
      emissiveIntensity: 0.15,
    });

    const panelL = new THREE.Mesh(panelGeo, panelMat);
    panelL.position.set(-s * 0.8, 0, 0);
    group.add(panelL);

    const panelR = new THREE.Mesh(panelGeo, panelMat);
    panelR.position.set(s * 0.8, 0, 0);
    group.add(panelR);

    return group;
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * Per-frame update: propagate orbits, update positions, blink strobes.
   * @param {number} dt - Real-time delta (seconds)
   * @param {THREE.Vector3} [playerPos] - Player position for proximity warnings
   */
  update(dt, playerPos) {
    const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY;

    // Blink timer
    this._blinkTimer += dt;
    if (this._blinkTimer > 0.5) {
      this._blinkTimer = 0;
      this._blinkState = !this._blinkState;
    }

    for (const sat of this.satellites) {
      // Propagate
      // Use pre-allocated orbit temp instead of spread
      const o = sat.orbit;
      this._tmpKmOrbit.semiMajorAxis = o.semiMajorAxis / Constants.SCENE_SCALE;
      this._tmpKmOrbit.eccentricity = o.eccentricity;
      this._tmpKmOrbit.inclination = o.inclination;
      this._tmpKmOrbit.raan = o.raan;
      this._tmpKmOrbit.argPerigee = o.argPerigee;
      this._tmpKmOrbit.trueAnomaly = o.trueAnomaly;
      this._tmpKmOrbit.meanMotion = o.meanMotion;
      propagateOrbit(this._tmpKmOrbit, gameDt);
      o.trueAnomaly = this._tmpKmOrbit.trueAnomaly;
      o.meanMotion = this._tmpKmOrbit.meanMotion;

      // Update position
      const cart = orbitToSceneCartesian(sat.orbit);
      sat.mesh.position.set(cart.position.x, cart.position.y, cart.position.z);

      // Orient along velocity
      const v = cart.velocity;
      const vLen = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (vLen > 1e-10) {
        const velDir = this._tmpVelDir.set(v.x, v.y, v.z).normalize();
        const radial = this._tmpRadial.copy(sat.mesh.position).normalize();
        const tgt = this._tmpTarget.copy(sat.mesh.position).add(velDir);
        this._tmpMat4.lookAt(sat.mesh.position, tgt, radial);
        sat.mesh.quaternion.setFromRotationMatrix(this._tmpMat4);
      }

      // Strobe blink
      sat.strobe.visible = this._blinkState;

      // Proximity warning
      if (playerPos) {
        const dist = sat.mesh.position.distanceTo(playerPos);
        const warningRange = 0.005; // ~500m in scene units
        if (dist < warningRange) {
          eventBus.emit(Events.ACTIVE_SAT_PROXIMITY, {
            name: sat.name,
            distance: dist,
            distanceKm: dist / Constants.SCENE_SCALE,
          });
        }
        // Collision check
        if (dist < sat.collisionRadius) {
          eventBus.emit(Events.ACTIVE_SAT_COLLISION, {
            name: sat.name,
            distance: dist,
          });
        }
      }
    }
  }

  /**
   * Get list of active satellites with their current positions.
   * @returns {Array<{ name: string, position: THREE.Vector3, distance: number }>}
   */
  getSatelliteList(playerPos) {
    return this.satellites.map(sat => ({
      name: sat.name,
      position: sat.mesh.position.clone(),
      distance: playerPos ? sat.mesh.position.distanceTo(playerPos) : Infinity,
    })).sort((a, b) => a.distance - b.distance);
  }

  /**
   * Get count of active satellites.
   * @returns {number}
   */
  getCount() {
    return this.satellites.length;
  }
}

export default ActiveSatellites;
