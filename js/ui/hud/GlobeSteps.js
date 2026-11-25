/**
 * GlobeSteps.js — what the bare `-` and `+` keys do on the globe (floor 4): one calm step per press (owner 2026-11-24, DECISIONS §102 rows 1
 * and 3). From the fullest view to the emptiest:
 *
 *   [panes `+` brought in past the arrival view] … [+1: the score bar] · 0: the view at arrival · −1: a highlight that is on goes off (one step, only
 *   when one is on; Sky 33, the review of Sky 32: the panel that holds its header and "Off" is the next step, so without this the highlight could
 *   not be turned off) · −2: the object panel hidden · −3: the time buttons hidden · −4 …: one ticked box unticked per press, the lowest box first,
 *   until none is ticked. The boxes are the key's
 *   three groups (a group is ONE box, open or closed) and "reach": from the bottom reach, Debris, Rocket stages, Satellites (Sky 32, owner
 *   2026-11-24, DECISIONS §104 row 4). The "military" mark is never one of them.
 *
 * `-` moves one step down, `+` one step up. Above 0 the steps are the ones the pane ladder already had (the mother box and the other
 * panes the room leaves out; PaneDensity.hideRung / up()); the score bar is the first `+` from 0 and the last `-` before 0 (the globe's
 * room no longer shows it, FloorMask `score: 'gone'`). Below 0 each `+` undoes the last step it can: the last unticked box is ticked again
 * (a group comes back exactly as it was before that `-`: a kind the player had unticked stays unticked, which `setTicked(group, true)` does by
 * remembering), then the time buttons come back, then the panel, then the highlight (the same item, with the same "+ stages" / "+ debris" /
 * "+ dead" state: `highlight.off()` hands back a snapshot that `highlight.restore(snapshot)` re-applies; a highlight the player turned on
 * again meanwhile is left alone). A tapped dot shows the panel again by itself (RealSkyCard.setObject): its step is then
 * stale and skipped. The rails, the game message line and the page dots are never touched at any step.
 *
 * Leaving the globe (`sync(false)`) gives the panel and the time buttons back and forgets the steps; the ticks stay as the player left them
 * (an untick by `-` is a real untick, saved by the layer like a click on the box).
 *
 * Pure and Node-testable: every collaborator is injected (main.js wires the live ones inside the ladder gate).
 *
 * @module ui/hud/GlobeSteps
 */

/**
 * @typedef {Object} GlobeStepsDeps
 * @property {() => boolean} isGlobe                 the ladder is on floor 4
 * @property {() => object|null} paneDensity         the PaneDensity (up(), hideRung(), find())
 * @property {() => object|null} mask                the FloorMask (extraRungGroups(), setAttributePane(), attributePaneShown())
 * @property {{isShown: () => boolean, setHidden: (hidden: boolean) => void}} panel   the object panel (shown = on screen and not hidden by a step)
 * @property {{isHidden: () => boolean, setHidden: (hidden: boolean) => void}} clock  the time buttons
 * @property {{ticked: () => string[], setTicked: (name: string, on: boolean) => void}} kinds  the key's boxes (the three groups and "reach"): `ticked()` lists the
 *   ticked boxes that show, top to bottom in the order they are drawn; `setTicked(name, false)` unticks a box and remembers what was ticked in it,
 *   `setTicked(name, true)` brings that back (`globeStepsKinds` builds it)
 * @property {{isOn: () => boolean, off: () => *, restore: (snapshot: *) => void}} [highlight]  the Highlight menu: `isOn()` a menu highlight is on;
 *   `off()` turns it off and returns a snapshot of what it was (item, extras, "+ dead"); `restore(snapshot)` puts the same item back with that state
 */

/**
 * The `kinds` dependency of GlobeSteps for the key (one function, so main.js and the tests build it the same way; Sky 33 review e). The boxes `-` and `+`
 * count are the three groups (a group is ONE box, open or closed) and "reach" last (`card.keyBoxes()`). A group is ticked while any of its kinds is;
 * `-` unticks it and remembers which were ticked, `+` brings exactly those back. The "military" mark is not one of them. "reach" is the orb's switch.
 * @param {{card: {keyBoxes: () => string[], groupState: (id: string) => string, setGroupTicked: (id: string, on: boolean) => void, refreshKinds: () => void},
 *   reachName: string, reach: () => {isEnabled: () => boolean, setEnabled: (on: boolean) => void}}} o `reach` is read at each call (the orb may not exist yet when this is built)
 * @returns {{ticked: () => string[], setTicked: (name: string, on: boolean) => void}}
 */
export function globeStepsKinds({ card, reachName, reach }) {
  return {
    ticked: () => card.keyBoxes().filter((n) => (n === reachName ? reach().isEnabled() : card.groupState(n) !== 'off')),
    setTicked: (n, on) => { if (n === reachName) { reach().setEnabled(on); card.refreshKinds(); } else card.setGroupTicked(n, on); },
  };
}

export class GlobeSteps {
  /** @param {GlobeStepsDeps} deps */
  constructor(deps = {}) {
    this._isGlobe = typeof deps.isGlobe === 'function' ? deps.isGlobe : () => false;
    this._pd = typeof deps.paneDensity === 'function' ? deps.paneDensity : () => null;
    this._mask = typeof deps.mask === 'function' ? deps.mask : () => null;
    this._panel = deps.panel || null;
    this._clock = deps.clock || null;
    this._kinds = deps.kinds || null;
    this._highlight = deps.highlight || null;
    /** @type {Array<{k: 'highlight'|'panel'|'clock'|'kind', id?: string, snap?: *}>} the steps taken below 0, oldest first */
    this._undo = [];
    /** Rung ids a `-` hid that still read shown (a pane that will not take the hide): skipped, so a press never repeats itself. */
    this._skip = new Set();
  }

  /** The keys act as steps while the ladder is on the globe. PaneDensity's step hook reads this. */
  active() { return !!this._isGlobe(); }

  /** Steps taken below 0 (tests, the probe). */
  depth() { return this._undo.length; }

  /** The score bar shows now (the room's bit and the density's bit both allow it). */
  scoreShown() {
    const mask = this._mask(), pd = this._pd();
    if (!mask || typeof mask.attributePaneShown !== 'function') return false;
    if (mask.attributePaneShown('score') !== true) return false;
    const rung = pd && typeof pd.find === 'function' ? pd.find('score') : null;
    try { return rung ? !!rung.isVisible() : true; } catch (_e) { return false; }
  }

  _showScore() {
    const mask = this._mask(), pd = this._pd();
    if (mask && typeof mask.setAttributePane === 'function') mask.setAttributePane('score', true);
    const rung = pd && typeof pd.find === 'function' ? pd.find('score') : null;
    if (rung && typeof rung.setVisible === 'function') { try { rung.setVisible(true); } catch (_e) { /* refused */ } }   // clears the density bit a floor-3 `-` may have left
  }

  _hideScore() {
    const mask = this._mask();
    if (mask && typeof mask.setAttributePane === 'function') mask.setAttributePane('score', false);
  }

  /** The panes `+` brought in past the arrival view, highest step first, minus the ones that would not hide. */
  _extraGroups() {
    const mask = this._mask();
    if (!mask || typeof mask.extraRungGroups !== 'function') return [];
    return mask.extraRungGroups().map((g) => g.filter((id) => !this._skip.has(id))).filter((g) => g.length);
  }

  /** `-`: one step down. @returns {boolean} a step was taken */
  down() {
    if (!this.active()) return false;
    const pd = this._pd();
    // Above the arrival view: take back what `+` brought in, the last one first.
    const groups = this._extraGroups();
    if (groups.length && pd && typeof pd.hideRung === 'function') {
      for (const id of groups[0]) pd.hideRung(id, { force: true });
      for (const id of groups[0]) if (this._extraGroups().some((g) => g.includes(id))) this._skip.add(id);   // still reads shown: never repeat it
      return true;
    }
    if (this.scoreShown()) { this._hideScore(); return true; }
    // Below the arrival view: a highlight that is on goes off first (its header and "Off" live in the panel the next step hides), then the panel,
    // the time buttons, then the boxes from the bottom of the list up.
    if (this._highlight && this._highlight.isOn()) {
      const snap = this._highlight.off();
      if (snap != null) { this._undo.push({ k: 'highlight', snap }); return true; }
    }
    if (this._panel && this._panel.isShown()) { this._panel.setHidden(true); this._undo.push({ k: 'panel' }); return true; }
    if (this._clock && !this._clock.isHidden()) { this._clock.setHidden(true); this._undo.push({ k: 'clock' }); return true; }
    if (this._kinds) {
      const ticked = this._kinds.ticked();
      if (ticked.length) {
        const id = ticked[ticked.length - 1];
        this._kinds.setTicked(id, false);
        this._undo.push({ k: 'kind', id });
        return true;
      }
    }
    return false;   // nothing left but Earth: further `-` does nothing
  }

  /** `+`: one step up. @returns {boolean} a step was taken */
  up() {
    if (!this.active()) return false;
    // Below 0: undo the last step that is still undoable (a box the player re-ticked, a panel a tapped dot brought back: skipped).
    while (this._undo.length) {
      const rec = this._undo.pop();
      if (rec.k === 'kind') {
        if (this._kinds && !this._kinds.ticked().includes(rec.id)) { this._kinds.setTicked(rec.id, true); return true; }
      } else if (rec.k === 'clock') {
        if (this._clock && this._clock.isHidden()) { this._clock.setHidden(false); return true; }
      } else if (rec.k === 'panel') {
        if (this._panel && !this._panel.isShown()) { this._panel.setHidden(false); return true; }
      } else if (rec.k === 'highlight') {
        // the same item with the same state; skipped when the player turned a highlight on himself since
        if (this._highlight && !this._highlight.isOn()) { this._highlight.restore(rec.snap); return true; }
      }
    }
    // At 0: the score bar; from there the ladder's own `+` (the meters and the panes after them).
    if (!this.scoreShown()) { this._showScore(); return true; }
    const pd = this._pd();
    if (pd && typeof pd.up === 'function') pd.up();
    return true;
  }

  /**
   * Called every frame with whether the ladder is on the globe. Leaving it gives the panel and the time buttons back and forgets the steps
   * (the ticks stay). Cheap while nothing was taken.
   * @param {boolean} onGlobe
   */
  sync(onGlobe) {
    if (onGlobe) return;
    if (!this._undo.length && !this._skip.size) return;
    if (this._panel) this._panel.setHidden(false);
    if (this._clock) this._clock.setHidden(false);
    this._undo.length = 0;
    this._skip.clear();
  }
}

export default GlobeSteps;
