/**
 * GameState.js — Game state manager with finite state machine
 * @module core/GameState
 */

import { eventBus } from './EventBus.js';
import { Events } from './Events.js';
import { Constants } from './Constants.js';

/** @enum {string} */
export const GameStates = {
  MENU: 'MENU',
  BRIEFING: 'BRIEFING',
  ORBITAL_VIEW: 'ORBITAL_VIEW',
  APPROACH: 'APPROACH',
  INTERACTION: 'INTERACTION',
  SHOP: 'SHOP',
  GAME_OVER: 'GAME_OVER',
  WIN: 'WIN',
};

/**
 * Valid state transitions map.
 * Each key can transition to the listed states.
 */
const VALID_TRANSITIONS = {
  [GameStates.MENU]:         [GameStates.BRIEFING, GameStates.ORBITAL_VIEW, GameStates.APPROACH],
  [GameStates.BRIEFING]:     [GameStates.ORBITAL_VIEW, GameStates.APPROACH, GameStates.MENU],
  [GameStates.ORBITAL_VIEW]: [GameStates.APPROACH, GameStates.INTERACTION, GameStates.BRIEFING, GameStates.SHOP, GameStates.GAME_OVER, GameStates.WIN, GameStates.MENU],
  [GameStates.APPROACH]:     [GameStates.INTERACTION, GameStates.ORBITAL_VIEW, GameStates.SHOP, GameStates.GAME_OVER, GameStates.WIN, GameStates.MENU],
  [GameStates.INTERACTION]:  [GameStates.ORBITAL_VIEW, GameStates.SHOP, GameStates.GAME_OVER, GameStates.WIN],
  [GameStates.SHOP]:         [GameStates.BRIEFING, GameStates.ORBITAL_VIEW],
  [GameStates.GAME_OVER]:    [GameStates.MENU, GameStates.BRIEFING, GameStates.SHOP],
  [GameStates.WIN]:          [GameStates.MENU, GameStates.BRIEFING],
};

class GameState {
  constructor() {
    /** @type {string} */
    this.currentState = GameStates.MENU;

    /** @type {string|null} */
    this.previousState = null;

    /** @type {number} */
    this.score = 0;

    /** @type {number} */
    this.debrisCleared = 0;

    /** @type {number} */
    this.missionTime = 0;
  }

  /**
   * Transition to a new game state
   * @param {string} newState - Target state from GameStates enum
   * @param {object} [payload] - Optional data for the transition
   * @returns {boolean} Whether the transition succeeded
   */
  setState(newState, payload) {
    const allowed = VALID_TRANSITIONS[this.currentState];
    if (!allowed || !allowed.includes(newState)) {
      console.warn(
        `[GameState] Invalid transition: ${this.currentState} → ${newState}`
      );
      return false;
    }

    this.previousState = this.currentState;
    this.currentState = newState;

    eventBus.emit(Events.STATE_CHANGE, {
      from: this.previousState,
      to: this.currentState,
      payload,
    });

    return true;
  }

  /**
   * Get the current state
   * @returns {string}
   */
  getState() {
    return this.currentState;
  }

  /**
   * Check if the current state is an active gameplay state
   * (ORBITAL_VIEW, APPROACH, or INTERACTION).
   * @returns {boolean}
   */
  isGameplay() {
    return this.currentState === GameStates.ORBITAL_VIEW ||
           this.currentState === GameStates.APPROACH ||
           this.currentState === GameStates.INTERACTION;
  }

  /**
   * Update per-frame logic tied to game state
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    this.missionTime += dt;

    // S1 Fix L2: Emit GAME_WIN so GameFlowManager can run its full
    // transitionToState(WIN) (which shows the victory screen, saves, etc.).
    // Previously this called setState(WIN) directly, bypassing GameFlowManager.
    // The _winEmitted guard prevents duplicate emissions across frames.
    if (this.debrisCleared >= Constants.WIN_DEBRIS_COUNT) {
      if (!this._winEmitted &&
          this.currentState !== GameStates.WIN &&
          this.currentState !== GameStates.GAME_OVER) {
        this._winEmitted = true;
        eventBus.emit(Events.GAME_WIN, { debrisCleared: this.debrisCleared });
      }
    }
  }

  /**
   * Add score points
   * @param {number} points
   */
  addScore(points) {
    this.score += points;
    eventBus.emit(Events.SCORE_UPDATE, { total: this.score, delta: points });
  }

  /**
   * Increment debris cleared count
   */
  clearDebris() {
    this.debrisCleared += 1;
    eventBus.emit(Events.DEBRIS_CLEARED, { count: this.debrisCleared });
  }

  /**
   * Reset to initial state for a new game
   */
  reset() {
    this.currentState = GameStates.MENU;
    this.previousState = null;
    this.score = 0;
    this.debrisCleared = 0;
    this.missionTime = 0;
    this._winEmitted = false;  // S1 Fix L2: reset guard on new game
  }
}

export const gameState = new GameState();
export default gameState;
