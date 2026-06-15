/**
 * test-CargoSystem.js — cargo manifest integrity guard.
 *
 * Regression for the 2026-06-14 shop crash: CARGO_STORE is also emitted as a
 * capture *notification* (CaptureNet's { debrisId, mass, netCapture } payload,
 * which has no metalId/massKg). CargoSystem.storeMetal used to blindly store
 * it, creating a Map entry keyed `undefined` with NaN mass — which then crashed
 * ShopScreen._refreshCargoManifest on `item.metalId.startsWith`.
 */
import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { CargoSystem } from '../systems/CargoSystem.js';

describe('CargoSystem — manifest integrity', () => {
  it('ignores a CaptureNet-style notification payload (no metalId)', () => {
    const cargo = new CargoSystem();
    const res = cargo.storeMetal({
      debrisId: 'd1', mass: 12, source: 'daughter', armIndex: 0, netCapture: true,
    });
    assert.equal(res.stored, false, 'malformed payload is not stored');
    const status = cargo.getStatus();
    assert.equal(status.manifest.length, 0, 'manifest stays empty');
    cargo.dispose();
  });

  it('ignores a payload with metalId but non-finite massKg', () => {
    const cargo = new CargoSystem();
    assert.equal(cargo.storeMetal({ metalId: 'aluminum', name: 'Aluminum' }).stored, false);
    assert.equal(cargo.storeMetal({ metalId: 'aluminum', massKg: NaN }).stored, false);
    assert.equal(cargo.storeMetal({ metalId: 'aluminum', massKg: 0 }).stored, false);
    assert.equal(cargo.getStatus().manifest.length, 0, 'nothing stored');
    cargo.dispose();
  });

  it('stores a well-formed metal payload', () => {
    const cargo = new CargoSystem();
    const res = cargo.storeMetal({
      metalId: 'titanium', name: 'Titanium', massKg: 30, color: '#ccc',
      ispAsThrust: 0, marketValue: 5,
    });
    assert.equal(res.stored, true);
    const manifest = cargo.getStatus().manifest;
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].metalId, 'titanium');
    assert.equal(typeof manifest[0].metalId, 'string',
      'every manifest item has a string metalId (shop relies on startsWith)');
    cargo.dispose();
  });

  it('a CARGO_STORE notification on the bus never corrupts the manifest', () => {
    eventBus.clear();
    const cargo = new CargoSystem();
    // CaptureNet emits this on every net capture — must not become cargo.
    eventBus.emit(Events.CARGO_STORE, {
      debrisId: 'd2', mass: 8, source: 'mother', netCapture: true,
    });
    const manifest = cargo.getStatus().manifest;
    assert.ok(manifest.every(i => typeof i.metalId === 'string'),
      'no undefined-keyed entries reach the manifest');
    cargo.dispose();
    eventBus.clear();
  });

  it('restore() skips malformed persisted entries', () => {
    const cargo = new CargoSystem();
    cargo.restore({ entries: [
      { name: 'ghost', massKg: 5 },                          // no metalId
      { metalId: 'steel', name: 'Steel', massKg: 10 },       // valid
      { metalId: 'bad', name: 'Bad', massKg: NaN },          // bad mass
    ] });
    const manifest = cargo.getStatus().manifest;
    assert.equal(manifest.length, 1, 'only the valid entry restores');
    assert.equal(manifest[0].metalId, 'steel');
    cargo.dispose();
  });
});
