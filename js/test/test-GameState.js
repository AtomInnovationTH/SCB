/**
 * test-GameState.js — GameState FSM tests
 */
import { describe, it, assert } from './TestRunner.js';
import { gameState, GameStates } from '../core/GameState.js';

// ── State Transitions ──────────────────────────────────────────
describe('GameState - State Transitions', () => {
    gameState.reset();

    it('initial state after reset is MENU', () => {
        assert.equal(gameState.getState(), GameStates.MENU);
    });

    it('valid transition: MENU → BRIEFING succeeds', () => {
        gameState.reset();
        const ok = gameState.setState(GameStates.BRIEFING);
        assert.equal(ok, true);
        assert.equal(gameState.getState(), GameStates.BRIEFING);
    });

    it('valid transition: BRIEFING → ORBITAL_VIEW succeeds', () => {
        gameState.reset();
        gameState.setState(GameStates.BRIEFING);
        const ok = gameState.setState(GameStates.ORBITAL_VIEW);
        assert.equal(ok, true);
        assert.equal(gameState.getState(), GameStates.ORBITAL_VIEW);
    });

    it('valid transition: MENU → ORBITAL_VIEW succeeds', () => {
        gameState.reset();
        const ok = gameState.setState(GameStates.ORBITAL_VIEW);
        assert.equal(ok, true);
    });

    it('invalid transition: MENU → INTERACTION fails', () => {
        gameState.reset();
        const ok = gameState.setState(GameStates.INTERACTION);
        assert.equal(ok, false);
        assert.equal(gameState.getState(), GameStates.MENU);
    });

    it('ORBITAL_VIEW → INTERACTION → ORBITAL_VIEW round-trip', () => {
        gameState.reset();
        gameState.setState(GameStates.ORBITAL_VIEW);
        assert.equal(gameState.setState(GameStates.INTERACTION), true);
        assert.equal(gameState.setState(GameStates.ORBITAL_VIEW), true);
        assert.equal(gameState.getState(), GameStates.ORBITAL_VIEW);
    });

    it('setState returns true for valid, false for invalid', () => {
        gameState.reset();
        assert.equal(gameState.setState(GameStates.BRIEFING), true);
        assert.equal(gameState.setState(GameStates.WIN), false);
    });

    it('previousState tracks the last state', () => {
        gameState.reset();
        gameState.setState(GameStates.BRIEFING);
        assert.equal(gameState.previousState, GameStates.MENU);
        gameState.setState(GameStates.ORBITAL_VIEW);
        assert.equal(gameState.previousState, GameStates.BRIEFING);
    });
});

// ── Score & Debris ─────────────────────────────────────────────
describe('GameState - Score & Debris', () => {
    gameState.reset();

    it('addScore increments score', () => {
        gameState.reset();
        gameState.addScore(100);
        assert.equal(gameState.score, 100);
        gameState.addScore(50);
        assert.equal(gameState.score, 150);
    });

    it('clearDebris increments debris count', () => {
        gameState.reset();
        gameState.clearDebris();
        assert.equal(gameState.debrisCleared, 1);
        gameState.clearDebris();
        assert.equal(gameState.debrisCleared, 2);
    });

    it('isGameplay returns true in ORBITAL_VIEW state', () => {
        gameState.reset();
        gameState.setState(GameStates.ORBITAL_VIEW);
        assert.equal(gameState.isGameplay(), true);
    });

    it('isGameplay returns true in INTERACTION state', () => {
        gameState.reset();
        gameState.setState(GameStates.ORBITAL_VIEW);
        gameState.setState(GameStates.INTERACTION);
        assert.equal(gameState.isGameplay(), true);
    });

    it('isGameplay returns false in MENU state', () => {
        gameState.reset();
        assert.equal(gameState.isGameplay(), false);
    });

    it('reset clears score and debris', () => {
        gameState.addScore(500);
        gameState.clearDebris();
        gameState.reset();
        assert.equal(gameState.score, 0);
        assert.equal(gameState.debrisCleared, 0);
        assert.equal(gameState.missionTime, 0);
        assert.equal(gameState.getState(), GameStates.MENU);
    });
});
