/**
 * DebugOverlay.js — Ctrl+D performance metrics overlay (FPS, frame time, entity counts, arms, game state).
 * @module ui/DebugOverlay
 */

export class DebugOverlay {
    constructor() {
        this.visible = false;
        this._frameTimeSamples = [];
        this._maxSamples = 60; // 1 second at 60fps
        this._element = null;
        this._build();
    }

    _build() {
        this._element = document.createElement('div');
        this._element.id = 'debug-overlay';
        this._element.style.cssText = `
            position: fixed; top: 8px; left: 8px; z-index: 200;
            background: rgba(0,0,0,0.75); color: #0f0; padding: 8px 12px;
            font-family: var(--font-mono); font-size: 11px;
            line-height: 1.5; border: 1px solid rgba(0,255,0,0.3);
            border-radius: 4px; pointer-events: none; display: none;
            min-width: 280px; white-space: pre;
        `;
        document.body.appendChild(this._element);
    }

    toggle() {
        this.visible = !this.visible;
        this._element.style.display = this.visible ? 'block' : 'none';
    }

    /** @param {number} frameTimeMs - time for this frame, ms (call once per frame) */
    recordFrame(frameTimeMs) {
        this._frameTimeSamples.push(frameTimeMs);
        if (this._frameTimeSamples.length > this._maxSamples) {
            this._frameTimeSamples.shift();
        }
    }

    /** Latest instantaneous FPS without touching the UI; 0 if no sample or zero frame time. Feeds main.js runtimeAdapt. */
    getLastFps() {
        const samples = this._frameTimeSamples;
        if (!samples.length) return 0;
        const last = samples[samples.length - 1];
        if (!last || last <= 0) return 0;
        return 1000 / last;
    }

    /**
     * @param {object} data  gameState, debrisCount, bgDebrisCount, activeSatCount, and optional armsDeployed /
     *   armsDocked / armsExpended, cameraView, drawCalls, triangles, textures, welcomeDebris
     */
    update(data) {
        if (!this.visible) return;

        const samples = this._frameTimeSamples;
        const avgFrameTime = samples.length > 0
            ? samples.reduce((a, b) => a + b, 0) / samples.length
            : 0;
        const fps = avgFrameTime > 0 ? Math.round(1000 / avgFrameTime) : 0;
        const frameTimeStr = avgFrameTime.toFixed(1);

        const minFrame = samples.length > 0 ? Math.min(...samples).toFixed(1) : '0.0';
        const maxFrame = samples.length > 0 ? Math.max(...samples).toFixed(1) : '0.0';

        const lines = [
            `FPS: ${fps} | Frame: ${frameTimeStr}ms (${minFrame}-${maxFrame})`,
            `State: ${data.gameState || '?'} | Camera: ${data.cameraView || '?'}`,
            `Debris: ${data.debrisCount || 0} interactive + ${data.bgDebrisCount || 0} bg`,
            `Active Sats: ${data.activeSatCount || 0}`,
            `Arms: ${data.armsDocked || 0} docked · ${data.armsDeployed || 0} out · ${data.armsExpended || 0} spent`,
        ];

        if (data.drawCalls || data.triangles) {
            lines.push(`GL: ${data.drawCalls} draws | ${data.triangles} tris | ${data.textures} tex`);
        }

        // Mission 1 only: DebrisField.getWelcomeFieldDiagnostics(), used to tune the first-mission layout.
        if (Array.isArray(data.welcomeDebris) && data.welcomeDebris.length) {
            lines.push('── M1 Welcome Debris (size/pos/vis) ──');
            for (const p of data.welcomeDebris) {
                lines.push(this._formatWelcomePiece(p));
            }
        }

        this._element.textContent = lines.join('\n');
    }

    /** One DebrisField.getWelcomeFieldDiagnostics() entry as two overlay lines. */
    _formatWelcomePiece(p) {
        const m = (v, suffix = '') => (Number.isFinite(v) ? `${v.toFixed(0)}${suffix}` : '?');
        const m1 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');
        const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(0)}` : '?');

        const type = (p.type || '?').slice(0, 4).padEnd(4, ' ');
        const size = `${m1(p.sizeM)}m→${m1(p.renderM)}m`;
        const range = `rng ${m(p.rangeM, 'm')}`;
        const frame = `fwd ${signed(p.fwdM)} lat ${signed(p.latM)}`;
        const head = `D${p.label} ${type} ${size}  ${range} ${frame}`;

        // Line 2: visibility (alive+rendered), discovered, tracked, pinned, captured, net range, distance-LOD tier.
        const vis = p.visible ? '✓vis' : '✗hidden';
        const disc = p.discovered ? '●disc' : '○undisc';
        const trk = p.tracked ? 'trk' : 'no-trk';
        const pin = p.pinned ? ' pin' : '';
        const cap = p.captured ? ' CAUGHT' : '';
        const net = (p.inNetRange === null) ? '' : (p.inNetRange ? ' net✓' : ' net✗(out)');
        const lod = ` LOD:${p.lodState || '?'}`;
        const state = `   ${vis} ${disc} ${trk}${pin}${cap}${net}${lod}`;
        return `${head}\n${state}`;
    }

    dispose() {
        if (this._element && this._element.parentNode) {
            this._element.parentNode.removeChild(this._element);
        }
    }
}

export default DebugOverlay;
