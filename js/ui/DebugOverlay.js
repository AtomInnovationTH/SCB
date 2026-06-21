/**
 * DebugOverlay.js — Ctrl+D toggleable performance metrics overlay
 * Shows FPS, frame time, entity counts, arm status, and game state.
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

    /** @private */
    _build() {
        this._element = document.createElement('div');
        this._element.id = 'debug-overlay';
        this._element.style.cssText = `
            position: fixed; top: 8px; left: 8px; z-index: 200;
            background: rgba(0,0,0,0.75); color: #0f0; padding: 8px 12px;
            font-family: 'Courier New', monospace; font-size: 11px;
            line-height: 1.5; border: 1px solid rgba(0,255,0,0.3);
            border-radius: 4px; pointer-events: none; display: none;
            min-width: 280px; white-space: pre;
        `;
        document.body.appendChild(this._element);
    }

    /** Toggle visibility */
    toggle() {
        this.visible = !this.visible;
        this._element.style.display = this.visible ? 'block' : 'none';
    }

    /**
     * Record a frame timestamp for FPS calculation.
     * Call this at the start of each frame.
     * @param {number} frameTimeMs - Time for this frame in ms
     */
    recordFrame(frameTimeMs) {
        this._frameTimeSamples.push(frameTimeMs);
        if (this._frameTimeSamples.length > this._maxSamples) {
            this._frameTimeSamples.shift();
        }
    }

    /**
     * PR 4 / P1.5 — peek the latest instantaneous FPS without touching the UI.
     * Returns 0 if no sample has been recorded yet or last frame had zero time.
     * Used by main.js to feed the QualityManager.runtimeAdapt() history buffer.
     * @returns {number}
     */
    getLastFps() {
        const samples = this._frameTimeSamples;
        if (!samples.length) return 0;
        const last = samples[samples.length - 1];
        if (!last || last <= 0) return 0;
        return 1000 / last;
    }

    /**
     * Update display with current game metrics.
     * @param {object} data
     * @param {string} data.gameState - Current game state string
     * @param {number} data.debrisCount - Interactive debris count
     * @param {number} data.bgDebrisCount - Background debris count
     * @param {number} data.activeSatCount - Active satellite count
     * @param {number} [data.armsDeployed=0] - Number of deployed arms
     * @param {number} [data.armsDocked=0] - Number of docked arms
     * @param {number} [data.armsExpended=0] - Number of expended arms
     * @param {string} [data.cameraView=''] - Current camera view name
     * @param {number} [data.drawCalls=0] - WebGL draw calls
     * @param {number} [data.triangles=0] - WebGL triangles
     * @param {number} [data.textures=0] - WebGL textures in memory
     */
    update(data) {
        if (!this.visible) return;

        // Calculate FPS and avg frame time
        const samples = this._frameTimeSamples;
        const avgFrameTime = samples.length > 0
            ? samples.reduce((a, b) => a + b, 0) / samples.length
            : 0;
        const fps = avgFrameTime > 0 ? Math.round(1000 / avgFrameTime) : 0;
        const frameTimeStr = avgFrameTime.toFixed(1);

        // Min/max frame time
        const minFrame = samples.length > 0 ? Math.min(...samples).toFixed(1) : '0.0';
        const maxFrame = samples.length > 0 ? Math.max(...samples).toFixed(1) : '0.0';

        const lines = [
            `FPS: ${fps} | Frame: ${frameTimeStr}ms (${minFrame}-${maxFrame})`,
            `State: ${data.gameState || '?'} | Camera: ${data.cameraView || '?'}`,
            `Debris: ${data.debrisCount || 0} interactive + ${data.bgDebrisCount || 0} bg`,
            `Active Sats: ${data.activeSatCount || 0}`,
            `Arms: ${data.armsDocked || 0}⚓ ${data.armsDeployed || 0}🚀 ${data.armsExpended || 0}✕`,
        ];

        // WebGL stats (if available)
        if (data.drawCalls || data.triangles) {
            lines.push(`GL: ${data.drawCalls} draws | ${data.triangles} tris | ${data.textures} tex`);
        }

        // Mission-1 welcome-field diagnostics (size / position / visibility per piece).
        // Provided by DebrisField.getWelcomeFieldDiagnostics(); only present on
        // mission 1 (the curated learning cluster). Used to tune first-mission layout.
        if (Array.isArray(data.welcomeDebris) && data.welcomeDebris.length) {
            lines.push('── M1 Welcome Debris (size/pos/vis) ──');
            for (const p of data.welcomeDebris) {
                lines.push(this._formatWelcomePiece(p));
            }
        }

        this._element.textContent = lines.join('\n');
    }

    /**
     * Format one welcome-field diagnostic piece into two compact overlay lines.
     * @private
     * @param {object} p - entry from DebrisField.getWelcomeFieldDiagnostics()
     * @returns {string}
     */
    _formatWelcomePiece(p) {
        const m = (v, suffix = '') => (Number.isFinite(v) ? `${v.toFixed(0)}${suffix}` : '?');
        const m1 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');
        const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(0)}` : '?');

        // Line 1 — identity + SIZE + POSITION.
        const type = (p.type || '?').slice(0, 4).padEnd(4, ' ');
        const size = `${m1(p.sizeM)}m→${m1(p.renderM)}m`;
        const range = `rng ${m(p.rangeM, 'm')}`;
        const frame = `fwd ${signed(p.fwdM)} lat ${signed(p.latM)}`;
        const head = `D${p.label} ${type} ${size}  ${range} ${frame}`;

        // Line 2 — VISIBILITY state. ✓/✗ alive+rendered, disc/hid, trk, pin,
        // captured, net-range, and the distance-LOD tier.
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

    /** Remove from DOM */
    dispose() {
        if (this._element && this._element.parentNode) {
            this._element.parentNode.removeChild(this._element);
        }
    }
}

export default DebugOverlay;
