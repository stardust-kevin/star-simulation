/**
 * Star Simulation - Firmware Core (Marlin-style state machine)
 *
 * Pure ESM. No Node.js-specific imports. ASCII comments only.
 *
 * Three simulation dimensions covered here:
 *   1. Motion & Extrusion  (G0/G1/G2/G3/G28/G92/G10/G11/M82/M83)
 *   2. G-code Control      (M104/M109/M140/M190/M106/M107/M220/M221/M600/T0-T3/M112/M999)
 *   3. Status Queries      (M105/M114/M115/M119/M503/M400/M27/M31/M20)
 *
 * PrintExecutor is the single physical executor: TCP lines from the host
 * software and POST /load from the web UI both funnel through it. Its virtual
 * clock advances at wall_dt * speedFactor, so the web renderer (which mirrors
 * state while idle) and a TCP host (which queries M114) observe identical
 * positions.
 */

export const AMBIENT_TEMP = 20.0;
export const COLD_EXTRUDE_MIN = 170.0;
export const LEAK_TEMP_MIN = 180.0;
export const RING_SIZE = 16;
export const FIRMWARE_NAME = 'Marlin 2.1 Simulated';
export const FIRMWARE_VERSION = '2.1.SIM';

export const PRINTER_DEFAULTS = {
    bed: { x: 220, y: 220, z: 380 },
    maxFeedrate: { x: 300, y: 300, z: 10, e: 50 },
    maxAccel: { x: 3000, y: 3000, z: 200, e: 10000 },
    printAccel: 3000,
    moveAccel: 3000,
    retractAccel: 3000,
    maxJerk: { x: 8, y: 8, z: 0.4, e: 5 },
    junctionDeviation: 0.013,
    speedFactor: 1.0,
    flowFactor: 1.0,
    softEndstops: true,
    stepsPerMM: { x: 80, y: 80, z: 400, e: 93 },
    filamentDia: 1.75,
    filamentDensity: 1.24,
    retractLength: 4.5,
    retractSpeed: 40,
    retractZLift: 0.0,
    recoverExtra: 0.0,
    probeOffsetZ: 0.0,
    hotendMax: 300,
    bedMax: 120,
    coldExtrudeAllow: false,

    // G28 home kinematics (values in mm/s except feedrate arrays which are mm/min
    // because G-code F is mm/min; caller multiplies by 60 internally).
    homeFeedrate: { x: 80, y: 80, z: 8 },
    homeSlowFeedrate: { x: 25, y: 25, z: 4 },
    homeBounce: 5,
    homeZLift: 5,

    // Hotend auto-fan (Marlin EXTRUDER_AUTO_FAN_TEMPERATURE)
    autoFanTemp: 50,
    autoFanPWM: 1.0
};

function cloneDeep(o) { return JSON.parse(JSON.stringify(o)); }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function roundTo(v, d = 2) { const p = Math.pow(10, d); return Math.round(v * p) / p; }

// ---------------------------------------------------------------------------
// Trapezoid progress: identical math to the front-end helper so the two
// executors (browser local + backend authoritative) produce the same curve.
// ---------------------------------------------------------------------------
export function trapezoidProgress(t, a, d) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    a = Math.max(a, 0.001);
    d = Math.max(d, 0.001);
    const sum = a + d;
    if (sum > 0.98) { const k = 0.98 / sum; a *= k; d *= k; }
    const vpeak = 1 / (1 - (a + d) / 2);
    if (t < a) return vpeak * t * t / (2 * a);
    if (t > 1 - d) { const u = 1 - t; return 1 - vpeak * u * u / (2 * d); }
    return vpeak * a / 2 + vpeak * (t - a);
}

// ---------------------------------------------------------------------------
// PrintExecutor: time-ordered segment list + virtual clock.
// Segment kinds:
//   { type:'move',      from,to,e0,e1,extruding,duration,lineNum,onComplete }
//   { type:'set_temp',  target,isBed,wait,lineNum,onComplete }
//   { type:'immediate', cmd,words,rawLine,lineNum,onComplete }
//   { type:'dwell',     duration,lineNum,onComplete }
//   { type:'pause',     reason,lineNum,onComplete }
//   { type:'halt',      lineNum,onComplete }
// ---------------------------------------------------------------------------
export class PrintExecutor {
    constructor(core) {
        this.core = core;
        this.plan = [];
        this.index = 0;
        this.segElapsed = 0;
        this.running = false;
        this.paused = false;
        this.blocked = false;
        this.stepOnce = false;
        this.speedFactor = 1.0;
        this.pauseReason = null;
        this._pendingWait = null;

        this.planningState = {
            absolutePosition: true,
            absoluteExtrusion: true,
            absoluteArcCenter: false,
            e: 0,
            feedrate: 1500,
            unitScale: 1.0
        };
        this.planningPos = { x: 0, y: 0, z: 0 };
    }

    // -----------------------------------------------------------------------
    // Load an entire G-code program (web path: POST /load).
    // -----------------------------------------------------------------------
    load(gcodeText) {
        this.plan = [];
        this.index = 0;
        this.segElapsed = 0;
        this.running = false;
        this.paused = false;
        this.blocked = false;
        this.stepOnce = false;
        this.pauseReason = null;
        this._pendingWait = null;

        // Do NOT reset core.pos to 0. The head is physically somewhere.
        this.core.state.e = 0;
        this.core.state.absolutePosition = true;
        this.core.state.absoluteExtrusion = true;
        this.core.state.absoluteArcCenter = false;
        this.core.state.unitScale = 1.0;
        this.core.state.feedrate = 1500;
        this.core.stats = {
            filamentUsed: 0, printTime: 0, layers: 0, maxZ: 0, lastLayerZ: 0
        };

        this.planningState = {
            absolutePosition: true, absoluteExtrusion: true,
            absoluteArcCenter: false, e: 0, feedrate: 1500, unitScale: 1.0
        };

        // Initialize planning position from current physical position
        this.planningPos = { x: this.core.pos.x, y: this.core.pos.y, z: this.core.pos.z };

        const lines = String(gcodeText).split('\n');
        for (let i = 0; i < lines.length; i++) {
            const parsed = this.core.parseGCodeLine(lines[i]);
            if (!parsed) continue;
            this._enqueueParsed(parsed, lines[i], i + 1, null);
        }

        this.running = this.plan.length > 0;
        this.paused = false;
        return this.plan.length;
    }

    // -----------------------------------------------------------------------
    // Enqueue a single parsed line (TCP path).
    // -----------------------------------------------------------------------
    enqueueLine(parsed, rawLine, lineNum, onComplete) {
        if (this.core.isImmediateCommand(parsed.command)) {
            const response = this.core.executeLine(rawLine);
            if (onComplete) onComplete(response);
            return false;
        }
        this._enqueueParsed(parsed, rawLine, lineNum, onComplete);
        if (!this.running) {
            this.running = true;
            this.paused = false;
            this.blocked = false;
        }
        return true;
    }

    // Shared helper. Push a raw move segment (no extrusion change).
    _pushMoveSeg(from, to, e0, e1, extruding, feed, lineNum, onComplete) {
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const duration = this.core.estimateDuration(dist, feed, { x: dx, y: dy, z: dz }, extruding, e1 - e0);
        this.plan.push({ type: 'move', from, to, e0, e1, extruding, duration, lineNum, onComplete });
        this.planningPos = { x: to.x, y: to.y, z: to.z };
        return duration;
    }

    _enqueueParsed(parsed, rawLine, lineNum, onComplete) {
        const cmd = parsed.command;
        const words = parsed.words;
        const ps = this.planningState;

        if (cmd === 'G0' || cmd === 'G1') {
            if (words.F !== undefined) ps.feedrate = words.F;
            const from = { x: this.planningPos.x, y: this.planningPos.y, z: this.planningPos.z };
            const to = { x: from.x, y: from.y, z: from.z };
            if (words.X !== undefined) to.x = (ps.absolutePosition ? words.X : from.x + words.X) * ps.unitScale;
            if (words.Y !== undefined) to.y = (ps.absolutePosition ? words.Y : from.y + words.Y) * ps.unitScale;
            if (words.Z !== undefined) to.z = (ps.absolutePosition ? words.Z : from.z + words.Z) * ps.unitScale;

            const c = this.core.clampXYZ(to.x, to.y, to.z);
            to.x = c.x; to.y = c.y; to.z = c.z;

            const e0 = ps.e;
            let e1 = e0;
            if (words.E !== undefined) {
                const ev = words.E * ps.unitScale;
                e1 = ps.absoluteExtrusion ? ev : e0 + ev;
            }
            const extruding = (e1 - e0) > 1e-6;

            const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const duration = this.core.estimateDuration(dist, ps.feedrate, { x: dx, y: dy, z: dz }, extruding, e1 - e0);

            this.plan.push({
                type: 'move', from, to, e0, e1, extruding, duration, lineNum, onComplete
            });

            this.core.stats.printTime += duration / 1000;
            if (extruding) {
                this.core.stats.filamentUsed += Math.abs(e1 - e0) * this.core.settings.flowFactor;
                if (to.z > 0 && dist > 1e-6) {
                    if (Math.abs(to.z - this.core.stats.lastLayerZ) > 0.01) {
                        this.core.stats.layers++;
                        this.core.stats.lastLayerZ = to.z;
                    }
                    if (to.z > this.core.stats.maxZ) this.core.stats.maxZ = to.z;
                }
            }
            this.planningPos = { x: to.x, y: to.y, z: to.z };
            ps.e = e1;
            return;
        }

        if (cmd === 'G2' || cmd === 'G3') {
            this._enqueueArc(words, cmd === 'G2', rawLine, lineNum, onComplete);
            return;
        }

        // Real-machine style G28: safety Z lift, then X/Y/Z fast home, bounce,
        // and a slow second-touch for each axis.
        if (cmd === 'G28') {
            const noWords = Object.keys(words).length === 0;
            const doX = noWords || words.X !== undefined;
            const doY = noWords || words.Y !== undefined;
            const doZ = noWords || words.Z !== undefined;
            const s = this.core.settings;
            const currentE = ps.e;

            const steps = [];

            const liftZ = Math.max(this.planningPos.z + s.homeZLift, s.homeZLift);
            if (doZ && this.planningPos.z < liftZ) {
                steps.push({ dx: null, dy: null, dz: liftZ, feed: 10 * 60 });
            }
            if (doX) {
                steps.push({ dx: 0, dy: null, dz: null, feed: s.homeFeedrate.x * 60 });
                steps.push({ dx: s.homeBounce, dy: null, dz: null, feed: s.homeFeedrate.x * 60 });
                steps.push({ dx: 0, dy: null, dz: null, feed: s.homeSlowFeedrate.x * 60 });
            }
            if (doY) {
                steps.push({ dx: null, dy: 0, dz: null, feed: s.homeFeedrate.y * 60 });
                steps.push({ dx: null, dy: s.homeBounce, dz: null, feed: s.homeFeedrate.y * 60 });
                steps.push({ dx: null, dy: 0, dz: null, feed: s.homeSlowFeedrate.y * 60 });
            }
            if (doZ) {
                steps.push({ dx: null, dy: null, dz: 0, feed: s.homeFeedrate.z * 60 });
                steps.push({ dx: null, dy: null, dz: 2, feed: s.homeFeedrate.z * 60 });
                steps.push({ dx: null, dy: null, dz: 0, feed: s.homeSlowFeedrate.z * 60 });
            }

            for (let i = 0; i < steps.length; i++) {
                const from = { x: this.planningPos.x, y: this.planningPos.y, z: this.planningPos.z };
                const to = { x: from.x, y: from.y, z: from.z };
                if (steps[i].dx !== null) to.x = steps[i].dx;
                if (steps[i].dy !== null) to.y = steps[i].dy;
                if (steps[i].dz !== null) to.z = steps[i].dz;
                const isLast = (i === steps.length - 1);
                this._pushMoveSeg(from, to, currentE, currentE, false, steps[i].feed, lineNum, isLast ? onComplete : null);
            }

            if (steps.length === 0 && onComplete) onComplete('ok');
            ps.e = 0;
            return;
        }

        if (cmd === 'G92') {
            this.plan.push({
                type: 'immediate', cmd: 'G92', words, rawLine, lineNum, onComplete
            });
            if (words.X !== undefined) this.planningPos.x = words.X * ps.unitScale;
            if (words.Y !== undefined) this.planningPos.y = words.Y * ps.unitScale;
            if (words.Z !== undefined) this.planningPos.z = words.Z * ps.unitScale;
            if (words.E !== undefined) ps.e = words.E * ps.unitScale;
            return;
        }

        if (cmd === 'G10' || cmd === 'G11') {
            this.plan.push({
                type: 'immediate', cmd, words, rawLine, lineNum, onComplete
            });
            const s = this.core.settings;
            if (cmd === 'G10') ps.e -= s.retractLength;
            else ps.e += s.retractLength + s.recoverExtra;
            return;
        }

        if (cmd === 'G90' || cmd === 'G91' || cmd === 'G90.1' || cmd === 'G91.1' ||
            cmd === 'G20' || cmd === 'G21' || cmd === 'M82' || cmd === 'M83') {
            this.plan.push({
                type: 'immediate', cmd, words, rawLine, lineNum, onComplete
            });
            if (cmd === 'G90') ps.absolutePosition = true;
            else if (cmd === 'G91') ps.absolutePosition = false;
            else if (cmd === 'G90.1') ps.absoluteArcCenter = true;
            else if (cmd === 'G91.1') ps.absoluteArcCenter = false;
            else if (cmd === 'G20') ps.unitScale = 25.4;
            else if (cmd === 'G21') ps.unitScale = 1.0;
            else if (cmd === 'M82') ps.absoluteExtrusion = true;
            else if (cmd === 'M83') ps.absoluteExtrusion = false;
            return;
        }

        if (cmd === 'M109' || cmd === 'M190') {
            const target = (words.S !== undefined) ? words.S : words.R;
            if (target !== undefined) {
                this.plan.push({
                    type: 'set_temp',
                    target,
                    isBed: (cmd === 'M190'),
                    wait: true,
                    lineNum,
                    onComplete
                });
            } else if (onComplete) {
                onComplete('ok');
            }
            return;
        }

        if (cmd === 'M400') {
            this.plan.push({ type: 'immediate', cmd: 'M400', words, rawLine, lineNum, onComplete });
            return;
        }

        if (cmd === 'M600' || cmd === 'M0' || cmd === 'M1') {
            if (cmd === 'M0' || cmd === 'M1') {
                if (words.S !== undefined && words.S > 0) {
                    this.plan.push({ type: 'dwell', duration: words.S * 1000, lineNum, onComplete });
                    return;
                }
            }
            this.plan.push({ type: 'pause', reason: (cmd === 'M600' ? 'filament_change' : 'user_pause'), lineNum, onComplete });
            return;
        }

        if (cmd === 'M112') {
            this.plan.push({ type: 'halt', lineNum, onComplete });
            return;
        }

        this.plan.push({
            type: 'immediate', cmd, words, rawLine, lineNum, onComplete
        });
    }

    _enqueueArc(words, clockwise, rawLine, lineNum, onComplete) {
        const ps = this.planningState;
        if (words.F !== undefined) ps.feedrate = words.F;

        const fromX = this.planningPos.x, fromY = this.planningPos.y, fromZ = this.planningPos.z;
        let toX = fromX, toY = fromY;
        if (words.X !== undefined) toX = (ps.absolutePosition ? words.X : fromX + words.X) * ps.unitScale;
        if (words.Y !== undefined) toY = (ps.absolutePosition ? words.Y : fromY + words.Y) * ps.unitScale;
        const toZ = words.Z !== undefined ? (ps.absolutePosition ? words.Z : fromZ + words.Z) * ps.unitScale : fromZ;

        let cx, cy;
        if (words.R !== undefined) {
            const r = words.R * ps.unitScale;
            const dx = toX - fromX, dy = toY - fromY;
            const chord = Math.hypot(dx, dy);
            if (chord < 1e-6) { if (onComplete) onComplete('ok'); return; }
            const h = Math.sqrt(Math.max(0, r * r - (chord * chord) / 4));
            const ux = -dy / chord, uy = dx / chord;
            const mx = (fromX + toX) / 2, my = (fromY + toY) / 2;
            const c1x = mx + ux * h, c1y = my + uy * h;
            const c2x = mx - ux * h, c2y = my - uy * h;
            const sweepOf = (px, py) => {
                const a0 = Math.atan2(fromY - py, fromX - px);
                const a1 = Math.atan2(toY - py, toX - px);
                let sw = a1 - a0;
                if (clockwise) { while (sw >= 0) sw -= 2 * Math.PI; }
                else { while (sw <= 0) sw += 2 * Math.PI; }
                return sw;
            };
            const s1 = sweepOf(c1x, c1y);
            const s2 = sweepOf(c2x, c2y);
            const wantMinor = r > 0;
            if (wantMinor ? Math.abs(s1) <= Math.abs(s2) : Math.abs(s1) > Math.abs(s2)) {
                cx = c1x; cy = c1y;
            } else { cx = c2x; cy = c2y; }
        } else {
            const ix = (words.I || 0) * ps.unitScale;
            const jy = (words.J || 0) * ps.unitScale;
            cx = ps.absoluteArcCenter ? ix : fromX + ix;
            cy = ps.absoluteArcCenter ? jy : fromY + jy;
        }

        const arcR = Math.hypot(fromX - cx, fromY - cy);
        if (arcR < 1e-6) { if (onComplete) onComplete('ok'); return; }

        const a0 = Math.atan2(fromY - cy, fromX - cx);
        const a1 = Math.atan2(toY - cy, toX - cx);
        let sweep = a1 - a0;
        if (clockwise) { while (sweep >= 0) sweep -= 2 * Math.PI; }
        else { while (sweep <= 0) sweep += 2 * Math.PI; }

        const arcLen = Math.abs(sweep) * arcR;
        const segs = Math.max(4, Math.min(2000, Math.ceil(arcLen / 0.5)));

        let e1 = ps.e;
        if (words.E !== undefined) {
            const ev = words.E * ps.unitScale;
            e1 = ps.absoluteExtrusion ? ev : ps.e + ev;
        }
        const totalE = e1 - ps.e;
        const segE = totalE / segs;

        let curX = fromX, curY = fromY, curZ = fromZ, curE = ps.e;
        for (let i = 1; i <= segs; i++) {
            const t = i / segs;
            const ang = a0 + sweep * t;
            const sx = (i === segs) ? toX : cx + arcR * Math.cos(ang);
            const sy = (i === segs) ? toY : cy + arcR * Math.sin(ang);
            const sz = fromZ + (toZ - fromZ) * t;
            const c = this.core.clampXYZ(sx, sy, sz);

            const dx = c.x - curX, dy = c.y - curY, dz = c.z - curZ;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const dur = this.core.estimateDuration(dist, ps.feedrate, { x: dx, y: dy, z: dz }, segE > 0, segE);

            this.plan.push({
                type: 'move',
                from: { x: curX, y: curY, z: curZ },
                to: { x: c.x, y: c.y, z: c.z },
                e0: curE, e1: curE + segE,
                extruding: segE > 1e-6,
                duration: dur,
                lineNum,
                onComplete: (i === segs) ? onComplete : null
            });

            this.core.stats.printTime += dur / 1000;
            if (segE > 1e-6) {
                this.core.stats.filamentUsed += Math.abs(segE) * this.core.settings.flowFactor;
                if (c.z > 0 && dist > 1e-6) {
                    if (Math.abs(c.z - this.core.stats.lastLayerZ) > 0.01) {
                        this.core.stats.layers++;
                        this.core.stats.lastLayerZ = c.z;
                    }
                    if (c.z > this.core.stats.maxZ) this.core.stats.maxZ = c.z;
                }
            }

            curX = c.x; curY = c.y; curZ = c.z; curE += segE;
        }

        this.planningPos = { x: curX, y: curY, z: curZ };
        ps.e = e1;
    }

    // -----------------------------------------------------------------------
    // Virtual clock tick. dtWall is in seconds.
    // -----------------------------------------------------------------------
    tick(dtWall) {
        // 1. Handle blocking temperature wait FIRST.
        // This prevents a deadlock where the tick returns early and never evaluates the temperature.
        if (this.blocked && this._pendingWait) {
            if (this.core.isTempWaitDone()) {
                this.blocked = false;
                const w = this._pendingWait;
                this._pendingWait = null;
                if (w.onComplete) w.onComplete('ok');
            } else {
                // Still waiting for temperature, skip motion ticking
                return;
            }
        }

        // 2. Stop ticking if not running or paused
        if (!this.running || this.paused) return;

        let simMs = dtWall * 1000 * this.speedFactor;
        if (this.stepOnce) simMs = 1e9;

        let guard = 0;
        while (simMs > 0 && this.running && !this.paused && !this.blocked) {
            if (this.index >= this.plan.length) { this.running = false; break; }
            if (++guard > 5000) break;

            const seg = this.plan[this.index];

            if (seg.type === 'move') {
                const remain = seg.duration - this.segElapsed;
                const used = Math.min(simMs, remain);
                this.segElapsed += used;
                simMs -= used;
                const t = (seg.duration > 1e-6) ? Math.min(1, this.segElapsed / seg.duration) : 1;
                const et = trapezoidProgress(t, 0.15, 0.15);
                this.core.pos.x = seg.from.x + (seg.to.x - seg.from.x) * et;
                this.core.pos.y = seg.from.y + (seg.to.y - seg.from.y) * et;
                this.core.pos.z = seg.from.z + (seg.to.z - seg.from.z) * et;
                this.core.state.e = seg.e0 + (seg.e1 - seg.e0) * et;

                if (this.segElapsed >= seg.duration - 0.001) {
                    this.core.pos.x = seg.to.x;
                    this.core.pos.y = seg.to.y;
                    this.core.pos.z = seg.to.z;
                    this.core.state.e = seg.e1;
                    this.index++;
                    this.segElapsed = 0;
                    if (seg.onComplete) seg.onComplete('ok');
                    if (this.stepOnce) { this.stepOnce = false; break; }
                }
                continue;
            }

            if (seg.type === 'set_temp') {
                if (seg.isBed) this.core.temps.bedTarget = clamp(seg.target, 0, this.core.settings.bedMax);
                else this.core.temps.hotendTarget = clamp(seg.target, 0, this.core.settings.hotendMax);
                this.index++;
                if (seg.wait) {
                    this.blocked = true;
                    this._pendingWait = seg;
                } else if (seg.onComplete) seg.onComplete('ok');
                if (this.stepOnce) { this.stepOnce = false; break; }
                continue;
            }

            if (seg.type === 'immediate') {
                const response = this.core.dispatch({
                    command: seg.cmd, words: seg.words, rawLine: seg.rawLine, stringData: ''
                });
                if (seg.onComplete) seg.onComplete(response || 'ok');
                this.index++;
                if (this.stepOnce) { this.stepOnce = false; break; }
                continue;
            }

            if (seg.type === 'dwell') {
                const remain = seg.duration - this.segElapsed;
                const used = Math.min(simMs, remain);
                this.segElapsed += used;
                simMs -= used;
                if (this.segElapsed >= seg.duration - 0.001) {
                    this.index++;
                    this.segElapsed = 0;
                    if (seg.onComplete) seg.onComplete('ok');
                    if (this.stepOnce) { this.stepOnce = false; break; }
                }
                continue;
            }

            if (seg.type === 'pause') {
                this.paused = true;
                this.pauseReason = seg.reason || 'pause';
                this.index++;
                if (seg.onComplete) seg.onComplete('busy: paused');
                break;
            }

            if (seg.type === 'halt') {
                this.running = false;
                this.core.halted = true;
                this.core.temps.hotendTarget = 0;
                this.core.temps.bedTarget = 0;
                this.core.waitingHotend = 0;
                this.core.waitingBed = 0;
                this.index++;
                if (seg.onComplete) seg.onComplete('ok');
                break;
            }

            this.index++;
        }
    }

    control(action, value) {
        switch (action) {
            case 'run':
                if (this.plan.length > 0 && this.index === 0) {
                    this.running = true;
                    this.paused = false;
                    this.blocked = false;
                }
                break;
            case 'pause':
                if (this.running && !this.paused) this.paused = true;
                break;
            case 'resume':
                if (this.running && this.paused) {
                    this.paused = false;
                    this.pauseReason = null;
                }
                break;
            case 'step':
                if (this.running && this.paused) {
                    this.paused = false;
                    this.stepOnce = true;
                    this.pauseReason = null;
                }
                break;
            case 'stop':
                this.running = false;
                this.paused = false;
                this.blocked = false;
                this.stepOnce = false;
                break;
            case 'speed':
                if (typeof value === 'number' && value > 0) {
                    this.speedFactor = Math.max(0.01, Math.min(5000, value));
                }
                break;
        }
    }
}

// ---------------------------------------------------------------------------
// PrinterCore: state machine + parsing + thermal.
// ---------------------------------------------------------------------------
export class PrinterCore {
    constructor() {
        this.settings = cloneDeep(PRINTER_DEFAULTS);
        this.settingsBackup = null;

        this.pos = { x: 0, y: 0, z: 0 };
        this.state = {
            absolutePosition: true,
            absoluteExtrusion: true,
            absoluteArcCenter: false,
            e: 0,
            feedrate: 1500,
            unitScale: 1.0
        };

        this.temps = {
            hotend: AMBIENT_TEMP + 4.5,
            hotendTarget: 0,
            bed: AMBIENT_TEMP + 3.1,
            bedTarget: 0
        };

        // Three fans matching Marlin convention:
        //   P0 = model cooling fan (M106 S)
        //   P1 = hotend heatsink fan (overridden by EXTRUDER_AUTO_FAN_TEMPERATURE)
        //   P2 = controller / board fan
        // `userFanPWM` stores the value commanded by M106/M107. `fanPWM` is the
        // effective output, which may be overridden for P1 by auto-fan.
        this.userFanPWM = [0, 0, 0];
        this.fanPWM = [0, 0, 0];

        this.steppersEnabled = true;
        this.halted = false;
        this.thermalRunaway = false;

        this.waitingHotend = 0;
        this.waitingBed = 0;
        this.waitSkip = false;
        this.hotendStableTime = 0;
        this.bedStableTime = 0;

        this.stats = {
            filamentUsed: 0, printTime: 0, layers: 0, maxZ: 0, lastLayerZ: 0
        };

        this.toolIndex = 0;
        this.mixColors = [];
        this._stuckTimer = 0;

        this.pidHotend = { kp: 0.06, ki: 0.0005, kd: 0.02, integral: 0, lastErr: 0 };
        this.pidBed = { kp: 0.10, ki: 0.0003, kd: 0.01, integral: 0, lastErr: 0 };

        this.executor = new PrintExecutor(this);
    }

    // -----------------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------------
    parseGCodeLine(line) {
        let cleanLine = String(line).replace(/\([^)]*\)/g, '');
        const semi = cleanLine.indexOf(';');
        if (semi >= 0) cleanLine = cleanLine.substring(0, semi);
        cleanLine = cleanLine.trim();
        if (!cleanLine) return null;
        const clean = cleanLine.toUpperCase();

        const words = {};
        let command = null;
        const tokenRe = /([A-Z])\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)?/g;
        let m;
        while ((m = tokenRe.exec(clean)) !== null) {
            const letter = m[1];
            const value = (m[2] !== undefined) ? parseFloat(m[2]) : null;
            if (command === null && (letter === 'G' || letter === 'M' || letter === 'T')) {
                if (letter === 'G' && value !== null) {
                    if (value === 90.1) command = 'G90.1';
                    else if (value === 91.1) command = 'G91.1';
                    else if (value === 1.1) command = 'G1';
                    else command = 'G' + Math.round(value);
                } else {
                    command = (value === null) ? letter : letter + Math.round(value);
                }
                continue;
            }
            if (value !== null) words[letter] = value;
        }

        let stringData = '';
        if (command === 'M117' || command === 'M118') {
            const mm = line.match(/^\s*M11[78]\s*(.*)$/i);
            if (mm) stringData = mm[1].split(';')[0].trim();
        }

        return command ? { command, words, rawLine: line, stringData } : null;
    }

    isImmediateCommand(cmd) {
        const QUEUED = {
            'G0': 1, 'G1': 1, 'G2': 1, 'G3': 1, 'G4': 1,
            'G10': 1, 'G11': 1, 'G20': 1, 'G21': 1, 'G28': 1, 'G92': 1,
            'G90': 1, 'G91': 1, 'G90.1': 1, 'G91.1': 1,
            'M0': 1, 'M1': 1, 'M82': 1, 'M83': 1,
            'M109': 1, 'M190': 1, 'M400': 1, 'M600': 1,
            'M117': 1, 'M118': 1, 'M163': 1, 'M164': 1,
            'T0': 1, 'T1': 1, 'T2': 1, 'T3': 1
        };
        return !QUEUED[cmd];
    }

    executeLine(line) {
        if (this.halted) {
            const upper = String(line).toUpperCase();
            if (upper.indexOf('M999') >= 0) {
                this.halted = false;
                this.thermalRunaway = false;
                return 'ok';
            }
            return 'error:Printer halted. Send M999 to reset.';
        }
        const parsed = this.parseGCodeLine(line);
        if (!parsed) return 'ok';
        return this.dispatch(parsed);
    }

    processTCPCommand(line) {
        return this.executeLine(line);
    }

    dispatch(parsed) {
        const { command, words } = parsed;
        switch (command) {
            case 'G0': case 'G1': this._dispatchMove(words); return 'ok';
            case 'G2': case 'G3': this._dispatchArc(words, command === 'G2'); return 'ok';
            case 'G4': this._dispatchDwell(words); return 'ok';
            case 'G10': this._dispatchRetract(); return 'ok';
            case 'G11': this._dispatchUnretract(); return 'ok';
            case 'G17': case 'G18': case 'G19': return 'ok';
            case 'G20': this.state.unitScale = 25.4; return 'ok';
            case 'G21': this.state.unitScale = 1.0; return 'ok';
            case 'G28': this._dispatchHome(words); return 'ok';
            case 'G29': return 'ok';
            case 'G90': this.state.absolutePosition = true; return 'ok';
            case 'G91': this.state.absolutePosition = false; return 'ok';
            case 'G90.1': this.state.absoluteArcCenter = true; return 'ok';
            case 'G91.1': this.state.absoluteArcCenter = false; return 'ok';
            case 'G92': this._dispatchSetPos(words); return 'ok';

            case 'M82': this.state.absoluteExtrusion = true; return 'ok';
            case 'M83': this.state.absoluteExtrusion = false; return 'ok';

            case 'M104':
                if (words.S !== undefined) this.temps.hotendTarget = clamp(words.S, 0, this.settings.hotendMax);
                return 'ok';
            case 'M109': {
                const t = (words.S !== undefined) ? words.S : words.R;
                if (t !== undefined) {
                    this.temps.hotendTarget = clamp(t, 0, this.settings.hotendMax);
                    this.waitingHotend = this.temps.hotendTarget;
                    return 'wait';
                }
                return 'ok';
            }
            case 'M140':
                if (words.S !== undefined) this.temps.bedTarget = clamp(words.S, 0, this.settings.bedMax);
                return 'ok';
            case 'M190': {
                const t = (words.S !== undefined) ? words.S : words.R;
                if (t !== undefined) {
                    this.temps.bedTarget = clamp(t, 0, this.settings.bedMax);
                    this.waitingBed = this.temps.bedTarget;
                    return 'wait';
                }
                return 'ok';
            }

            // Fan control. Marlin: P selects which fan (0=model, 1=hotend,
            // 2=controller). S is 0-255; omitted S defaults to full speed.
            case 'M106': {
                const p = words.P !== undefined ? Math.round(words.P) : 0;
                const s = words.S !== undefined ? clamp(words.S / 255, 0, 1) : 1.0;
                if (p >= 0 && p < 3) this.userFanPWM[p] = s;
                return 'ok';
            }
            case 'M107': {
                const p = words.P !== undefined ? Math.round(words.P) : 0;
                if (p >= 0 && p < 3) this.userFanPWM[p] = 0;
                return 'ok';
            }

            case 'M220':
                if (words.S !== undefined) this.settings.speedFactor = clamp(words.S / 100, 0.01, 10);
                return 'ok';
            case 'M221':
                if (words.S !== undefined) this.settings.flowFactor = clamp(words.S / 100, 0.01, 10);
                return 'ok';

            case 'M201': this._setAxis(words, 'maxAccel'); return 'ok';
            case 'M203': this._setAxis(words, 'maxFeedrate'); return 'ok';
            case 'M204':
                if (words.P !== undefined) this.settings.printAccel = words.P;
                if (words.T !== undefined) this.settings.moveAccel = words.T;
                if (words.R !== undefined) this.settings.retractAccel = words.R;
                if (words.S !== undefined) { this.settings.printAccel = words.S; this.settings.moveAccel = words.S; }
                return 'ok';
            case 'M205':
                if (words.X !== undefined) this.settings.maxJerk.x = words.X;
                if (words.Y !== undefined) this.settings.maxJerk.y = words.Y;
                if (words.Z !== undefined) this.settings.maxJerk.z = words.Z;
                if (words.E !== undefined) this.settings.maxJerk.e = words.E;
                if (words.J !== undefined) this.settings.junctionDeviation = words.J;
                return 'ok';
            case 'M206': return 'ok';
            case 'M207':
                if (words.S !== undefined) this.settings.retractLength = words.S;
                if (words.F !== undefined) this.settings.retractSpeed = words.F;
                if (words.Z !== undefined) this.settings.retractZLift = words.Z;
                return 'ok';
            case 'M208':
                if (words.S !== undefined) this.settings.recoverExtra = words.S;
                return 'ok';
            case 'M209': return 'ok';

            case 'M0': case 'M1': return 'ok';
            case 'M17': this.steppersEnabled = true; return 'ok';
            case 'M18': case 'M84': this.steppersEnabled = false; return 'ok';
            case 'M108': this.waitSkip = true; return 'ok';
            case 'M112':
                this.halted = true;
                this.thermalRunaway = false;
                this.temps.hotendTarget = 0;
                this.temps.bedTarget = 0;
                this.waitingHotend = 0;
                this.waitingBed = 0;
                return 'ok';
            case 'M117': case 'M118': return 'ok';
            case 'M400': return 'ok';

            case 'M500': this.settingsBackup = cloneDeep(this.settings); return 'ok';
            case 'M501':
                if (this.settingsBackup) this.settings = cloneDeep(this.settingsBackup);
                return 'ok';
            case 'M502': this.settings = cloneDeep(PRINTER_DEFAULTS); return 'ok';

            case 'M92': this._setAxis(words, 'stepsPerMM'); return 'ok';
            case 'M851':
                if (words.Z !== undefined) this.settings.probeOffsetZ = words.Z;
                return 'ok';

            case 'M600': this.toolIndex = (this.toolIndex + 1) % 4; return 'ok';
            case 'T0': case 'T1': case 'T2': case 'T3':
                this.toolIndex = parseInt(command.substring(1), 10) || 0;
                return 'ok';
            case 'M163':
                if (words.S !== undefined && words.P !== undefined) this.mixColors[words.S] = words.P;
                return 'ok';
            case 'M164': return 'ok';

            case 'M20': return 'Begin file list\nEnd file list\nok';
            case 'M27': return 'Not SD printing\nok';
            case 'M31': return 'echo:Print time: ' + this.stats.printTime.toFixed(0) + 's';
            case 'M105': return this._queryTemps();
            case 'M114': return this._queryPosition();
            case 'M115': return this._queryFirmware();
            case 'M119': return this._queryEndstops();
            case 'M503': return this._querySettings();

            case 'M999':
                this.halted = false;
                this.thermalRunaway = false;
                return 'ok';

            default: return 'ok';
        }
    }

    _dispatchMove(words) {
        if (words.F !== undefined) this.state.feedrate = words.F;
        const from = { ...this.pos };
        const to = { ...this.pos };
        if (words.X !== undefined) to.x = (this.state.absolutePosition ? words.X : from.x + words.X) * this.state.unitScale;
        if (words.Y !== undefined) to.y = (this.state.absolutePosition ? words.Y : from.y + words.Y) * this.state.unitScale;
        if (words.Z !== undefined) to.z = (this.state.absolutePosition ? words.Z : from.z + words.Z) * this.state.unitScale;

        const c = this.clampXYZ(to.x, to.y, to.z);
        this.pos.x = c.x; this.pos.y = c.y; this.pos.z = c.z;

        if (words.E !== undefined) {
            const ev = words.E * this.state.unitScale;
            this.state.e = this.state.absoluteExtrusion ? ev : this.state.e + ev;
        }
    }

    _dispatchArc(words, clockwise) {
        const tmpState = cloneDeep(this.state);
        const tmpPos = { ...this.pos };
        const exec = this.executor;
        const prevPS = cloneDeep(exec.planningState);
        const prevPP = { ...exec.planningPos };
        exec.planningState = tmpState;
        exec.planningPos = tmpPos;
        exec._enqueueArc(words, clockwise, '', 0, null);
        exec.planningState = prevPS;
        exec.planningPos = prevPP;
    }

    _dispatchDwell(words) {
        let ms = 0;
        if (words.P !== undefined) ms = words.P;
        else if (words.S !== undefined) ms = words.S * 1000;
        this.stats.printTime += Math.max(0, ms) / 1000;
    }

    _dispatchRetract() {
        const s = this.settings;
        if (s.retractLength <= 0) return;
        this.state.e -= s.retractLength;
        this.stats.printTime += s.retractLength / Math.max(1, s.retractSpeed / 60);
    }

    _dispatchUnretract() {
        const s = this.settings;
        if (s.retractLength <= 0) return;
        this.state.e += s.retractLength + s.recoverExtra;
        this.stats.printTime += (s.retractLength + s.recoverExtra) / Math.max(1, s.retractSpeed / 60);
    }

    _dispatchHome(words) {
        // Direct dispatch path (used by test harness). The executor path in
        // PrintExecutor._enqueueParsed performs the full homing sequence.
        const noWords = Object.keys(words).length === 0;
        if (noWords || words.Z !== undefined) this.pos.z = 0;
        if (noWords || words.X !== undefined) this.pos.x = 0;
        if (noWords || words.Y !== undefined) this.pos.y = 0;
        this.state.e = 0;
    }

    _dispatchSetPos(words) {
        const u = this.state.unitScale;
        if (words.X !== undefined) this.pos.x = words.X * u;
        if (words.Y !== undefined) this.pos.y = words.Y * u;
        if (words.Z !== undefined) this.pos.z = words.Z * u;
        if (words.E !== undefined) this.state.e = words.E * u;
    }

    _setAxis(words, key) {
        ['x', 'y', 'z', 'e'].forEach(a => {
            const L = a.toUpperCase();
            if (words[L] !== undefined) this.settings[key][a] = words[L];
        });
    }

    clampXYZ(x, y, z) {
        if (!this.settings.softEndstops) return { x, y, z };
        return {
            x: clamp(x, 0, this.settings.bed.x),
            y: clamp(y, 0, this.settings.bed.y),
            z: clamp(z, 0, this.settings.bed.z)
        };
    }

    estimateDuration(dist, feedrate, dv, extruding, eDelta) {
        const s = this.settings;
        if (dist <= 1e-6) {
            if (eDelta && Math.abs(eDelta) > 1e-6) {
                const eSpeed = Math.max(1, feedrate / 60) * s.speedFactor;
                return Math.max(20, (Math.abs(eDelta) / eSpeed) * 1000);
            }
            return 20;
        }
        let speed = Math.max(feedrate * this.state.unitScale, 60) / 60;
        speed *= s.speedFactor;
        if (dv) {
            if (Math.abs(dv.x) > 1e-6) speed = Math.min(speed, s.maxFeedrate.x * dist / Math.abs(dv.x));
            if (Math.abs(dv.y) > 1e-6) speed = Math.min(speed, s.maxFeedrate.y * dist / Math.abs(dv.y));
            if (Math.abs(dv.z) > 1e-6) speed = Math.min(speed, s.maxFeedrate.z * dist / Math.abs(dv.z));
        }
        const accel = Math.max(10, extruding ? s.printAccel : s.moveAccel);
        const vJunction = Math.sqrt(accel * s.junctionDeviation);
        speed = Math.min(speed, vJunction);
        speed = Math.min(speed, Math.sqrt(accel * dist));
        if (speed <= 0.001) return 2000;
        return Math.max(1, (dist / speed) * 1000 + (speed / accel) * 1000);
    }

    // -----------------------------------------------------------------------
    // Thermal model + auto-fan (EXTRUDER_AUTO_FAN_TEMPERATURE)
    // -----------------------------------------------------------------------
    tickThermal(dt) {
        if (this.halted || !(dt > 0)) return;

        // Fast path for high speed to prevent false thermal runaway
        if (dt > 5.0) {
            this.temps.hotend = (this.temps.hotendTarget > 1) ? this.temps.hotendTarget : AMBIENT_TEMP;
            this.temps.bed = (this.temps.bedTarget > 1) ? this.temps.bedTarget : AMBIENT_TEMP;
            this.hotendStableTime = 1.0;
            this.bedStableTime = 1.0;
            this._stuckTimer = 0;
            this._updateFanPWM();
            return;
        }

        const s = this.settings;
        const modelFan = this.fanPWM[0];
        const fanEffect = 1 + modelFan * 0.5;

        const prevHotend = this.temps.hotend;
        const prevBed = this.temps.bed;

        this.temps.hotend = this._pidStep(this.pidHotend, this.temps.hotend, this.temps.hotendTarget, dt, 25, 0.008 * fanEffect, s.hotendMax);
        this.temps.bed = this._pidStep(this.pidBed, this.temps.bed, this.temps.bedTarget, dt, 8, 0.004 * fanEffect, s.bedMax);

        if (this.temps.hotendTarget > 1 && Math.abs(this.temps.hotend - this.temps.hotendTarget) <= 1.5) this.hotendStableTime += dt;
        else this.hotendStableTime = 0;
        if (this.temps.bedTarget > 1 && Math.abs(this.temps.bed - this.temps.bedTarget) <= 1.5) this.bedStableTime += dt;
        else this.bedStableTime = 0;

        // Thermal Runaway Watchdog (Marlin behavior: reset if temperature is rising)
        if (this.temps.hotendTarget > 1 && this.temps.hotend < this.temps.hotendTarget - 5) {
            const rise = this.temps.hotend - prevHotend;
            if (rise < 0.05 * dt) {
                this._stuckTimer += dt;
            } else {
                this._stuckTimer = Math.max(0, this._stuckTimer - dt * 2);
            }
            if (this._stuckTimer > 120) {
                this.thermalRunaway = true;
                this.halted = true;
                this.temps.hotendTarget = 0;
                this.temps.bedTarget = 0;
            }
        } else {
            this._stuckTimer = 0;
        }

        this._updateFanPWM();
    }

    // Recompute effective fan PWM. P1 (hotend fan) is auto-driven by hotend
    // temperature (Marlin EXTRUDER_AUTO_FAN_TEMPERATURE), which overrides any
    // user setting while the hotend is hot. P0 and P2 follow user commands.
    _updateFanPWM() {
        this.fanPWM[0] = this.userFanPWM[0];
        this.fanPWM[1] = (this.temps.hotend > this.settings.autoFanTemp)
            ? Math.max(this.settings.autoFanPWM, this.userFanPWM[1])
            : this.userFanPWM[1];
        this.fanPWM[2] = this.userFanPWM[2];
    }

    _pidStep(state, current, target, dt, maxHeatRate, coolingFactor, maxTemp) {
        if (target < 1) {
            const cool = (current - AMBIENT_TEMP) * coolingFactor;
            return Math.max(AMBIENT_TEMP, current - cool * dt);
        }
        const err = target - current;
        state.integral += err * dt;
        if (state.integral > 100) state.integral = 100;
        if (state.integral < 0) state.integral = 0;
        const derr = (err - state.lastErr) / Math.max(dt, 0.001);
        state.lastErr = err;
        let power = state.kp * err + state.ki * state.integral + state.kd * derr;
        if (power > 1) power = 1;
        if (power < 0) power = 0;
        const heat = power * maxHeatRate;
        const cool = (current - AMBIENT_TEMP) * coolingFactor;
        let next = current + (heat - cool) * dt;
        if (next < AMBIENT_TEMP) next = AMBIENT_TEMP;
        if (next > maxTemp) next = maxTemp;
        return next;
    }

    isTempWaitDone() {
        if (this.waitSkip) {
            this.waitSkip = false;
            this.waitingHotend = 0;
            this.waitingBed = 0;
            return true;
        }
        if (this.waitingHotend > 0) {
            if (Math.abs(this.temps.hotend - this.temps.hotendTarget) > 1.5) return false;
            if (this.hotendStableTime < 0.8) return false;
        }
        if (this.waitingBed > 0) {
            if (Math.abs(this.temps.bed - this.temps.bedTarget) > 1.5) return false;
            if (this.bedStableTime < 0.8) return false;
        }
        return true;
    }

    _queryTemps() {
        return 'ok T:' + this.temps.hotend.toFixed(1) +
            ' /' + this.temps.hotendTarget.toFixed(1) +
            ' B:' + this.temps.bed.toFixed(1) +
            ' /' + this.temps.bedTarget.toFixed(1) +
            ' @:0 B@:0';
    }
    _queryPosition() {
        return 'ok X:' + this.pos.x.toFixed(2) +
            ' Y:' + this.pos.y.toFixed(2) +
            ' Z:' + this.pos.z.toFixed(2) +
            ' E:' + this.state.e.toFixed(2);
    }
    _queryFirmware() {
        return 'ok FIRMWARE_NAME:' + FIRMWARE_NAME +
            ' FIRMWARE_VERSION:' + FIRMWARE_VERSION +
            ' SOURCE_CODE_URL:github.com PROTOCOL_VERSION:1.0' +
            ' MACHINE_TYPE:3D Printer EXTRUDER_COUNT:1';
    }
    _queryEndstops() {
        const xStr = this.pos.x <= 0.1 ? 'TRIGGERED' : 'open';
        const yStr = this.pos.y <= 0.1 ? 'TRIGGERED' : 'open';
        const zStr = this.pos.z <= 0.1 ? 'TRIGGERED' : 'open';
        return 'Reporting endstop status\nx_min: ' + xStr +
            '\ny_min: ' + yStr + '\nz_min: ' + zStr + '\nok';
    }
    _querySettings() {
        const s = this.settings;
        return [
            'echo:Steps per unit:',
            'echo:  M92 X' + s.stepsPerMM.x.toFixed(2) +
            ' Y' + s.stepsPerMM.y.toFixed(2) +
            ' Z' + s.stepsPerMM.z.toFixed(2) +
            ' E' + s.stepsPerMM.e.toFixed(2),
            'echo:Maximum feedrates (mm/s):',
            'echo:  M203 X' + s.maxFeedrate.x.toFixed(2) +
            ' Y' + s.maxFeedrate.y.toFixed(2) +
            ' Z' + s.maxFeedrate.z.toFixed(2) +
            ' E' + s.maxFeedrate.e.toFixed(2),
            'echo:Maximum Acceleration (mm/s2):',
            'echo:  M201 X' + s.maxAccel.x.toFixed(0) +
            ' Y' + s.maxAccel.y.toFixed(0) +
            ' Z' + s.maxAccel.z.toFixed(0) +
            ' E' + s.maxAccel.e.toFixed(0),
            'echo:Acceleration (mm/s2): P<print> T<travel> R<retract>',
            'echo:  M204 P' + s.printAccel.toFixed(0) +
            ' T' + s.moveAccel.toFixed(0) +
            ' R' + s.retractAccel.toFixed(0),
            'echo:Advanced: J<junction>',
            'echo:  M205 J' + s.junctionDeviation.toFixed(3),
            'ok'
        ].join('\n');
    }

    // -----------------------------------------------------------------------
    // Snapshot for SSE broadcast. `fanSpeed` alias kept for back-compat with
    // any older client code; `fanSpeeds` is the canonical array [P0,P1,P2].
    // -----------------------------------------------------------------------
    snapshot() {
        this._updateFanPWM();
        return {
            x: roundTo(this.pos.x, 3),
            y: roundTo(this.pos.y, 3),
            z: roundTo(this.pos.z, 3),
            e: roundTo(this.state.e, 3),
            hotend: roundTo(this.temps.hotend, 2),
            hotendTarget: roundTo(this.temps.hotendTarget, 2),
            bed: roundTo(this.temps.bed, 2),
            bedTarget: roundTo(this.temps.bedTarget, 2),
            fanSpeed: roundTo(this.fanPWM[0], 3),
            fanSpeeds: [
                roundTo(this.fanPWM[0], 3),
                roundTo(this.fanPWM[1], 3),
                roundTo(this.fanPWM[2], 3)
            ],
            speedFactor: roundTo(this.settings.speedFactor, 3),
            flowFactor: roundTo(this.settings.flowFactor, 3),
            playbackSpeed: roundTo(this.executor.speedFactor, 3),
            running: this.executor.running,
            paused: this.executor.paused,
            blocked: this.executor.blocked,
            pauseReason: this.executor.pauseReason,
            planIndex: this.executor.index,
            planTotal: this.executor.plan.length,
            toolIndex: this.toolIndex,
            steppersEnabled: this.steppersEnabled,
            halted: this.halted,
            thermalRunaway: this.thermalRunaway,
            stats: {
                filamentUsed: roundTo(this.stats.filamentUsed, 2),
                printTime: roundTo(this.stats.printTime, 1),
                layers: this.stats.layers,
                maxZ: roundTo(this.stats.maxZ, 2)
            }
        };
    }
}