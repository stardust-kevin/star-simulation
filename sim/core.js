export class PrinterCore {
    constructor() {
        // Initialize all necessary state variables, including e (extruder)
        this.state = {
            absolutePosition: true,
            absoluteExtrusion: true,
            absoluteArcCenter: false,
            e: 0,
            feedrate: 1500,
            unitScale: 1.0
        };
        this.pos = { x: 0, y: 0, z: 0 };
        this.temps = {
            hotend: 24.5,
            hotendTarget: 0,
            bed: 23.1,
            bedTarget: 0
        };
        this.halted = false;
        this.fanSpeed = 0;
        this.speedFactor = 1.0;
        this.flowFactor = 1.0;
    }

    tickThermal(dt) {
        if (this.halted) return;

        const AMBIENT_TEMP = 20;

        if (this.temps.hotendTarget < 1) {
            this.temps.hotend = Math.max(AMBIENT_TEMP, this.temps.hotend - dt * 5);
        } else if (this.temps.hotend < this.temps.hotendTarget) {
            this.temps.hotend = Math.min(this.temps.hotendTarget, this.temps.hotend + dt * 10);
        } else if (this.temps.hotend > this.temps.hotendTarget) {
            this.temps.hotend = Math.max(this.temps.hotendTarget, this.temps.hotend - dt * 5);
        }

        if (this.temps.bedTarget < 1) {
            this.temps.bed = Math.max(AMBIENT_TEMP, this.temps.bed - dt * 1);
        } else if (this.temps.bed < this.temps.bedTarget) {
            this.temps.bed = Math.min(this.temps.bedTarget, this.temps.bed + dt * 2);
        } else if (this.temps.bed > this.temps.bedTarget) {
            this.temps.bed = Math.max(this.temps.bedTarget, this.temps.bed - dt * 1);
        }
    }

    isTempWaitDone() {
        const hotendDone = Math.abs(this.temps.hotend - this.temps.hotendTarget) < 1.0;
        const bedDone = Math.abs(this.temps.bed - this.temps.bedTarget) < 1.0;
        return hotendDone && bedDone;
    }

    parseGCodeLine(line) {
        let cleanLine = line.replace(/\([^)]*\)/g, '');
        const clean = cleanLine.split(';')[0].trim().toUpperCase();
        if (!clean) return null;

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
        return command ? { command, words } : null;
    }

    processTCPCommand(line) {
        if (this.halted && !line.toUpperCase().startsWith('M999')) {
            return "Error:Printer halted. Reset via M999.";
        }

        const parsed = this.parseGCodeLine(line);
        if (!parsed) return "ok";

        const { command, words } = parsed;

        switch (command) {
            case 'G0':
            case 'G1': {
                if (words.F !== undefined) this.state.feedrate = words.F;
                if (words.X !== undefined) this.pos.x = this.state.absolutePosition ? words.X : this.pos.x + words.X;
                if (words.Y !== undefined) this.pos.y = this.state.absolutePosition ? words.Y : this.pos.y + words.Y;
                if (words.Z !== undefined) this.pos.z = this.state.absolutePosition ? words.Z : this.pos.z + words.Z;
                if (words.E !== undefined) {
                    if (this.state.absoluteExtrusion) this.state.e = words.E;
                    else this.state.e += words.E;
                }
                return 'ok';
            }
            case 'G28':
                this.pos = { x: 0, y: 0, z: 0 };
                return 'ok';
            case 'G90': this.state.absolutePosition = true; return 'ok';
            case 'G91': this.state.absolutePosition = false; return 'ok';
            case 'G90.1': this.state.absoluteArcCenter = true; return 'ok';
            case 'G91.1': this.state.absoluteArcCenter = false; return 'ok';
            case 'G92':
                if (words.X !== undefined) this.pos.x = words.X;
                if (words.Y !== undefined) this.pos.y = words.Y;
                if (words.Z !== undefined) this.pos.z = words.Z;
                if (words.E !== undefined) this.state.e = words.E;
                return 'ok';
            case 'M82': this.state.absoluteExtrusion = true; return 'ok';
            case 'M83': this.state.absoluteExtrusion = false; return 'ok';

            case 'M104':
                if (words.S !== undefined) this.temps.hotendTarget = words.S;
                return 'ok';
            case 'M140':
                if (words.S !== undefined) this.temps.bedTarget = words.S;
                return 'ok';
            case 'M109':
                if (words.S !== undefined) this.temps.hotendTarget = words.S;
                return 'wait';
            case 'M190':
                if (words.S !== undefined) this.temps.bedTarget = words.S;
                return 'wait';

            case 'M105':
                return `ok T:${this.temps.hotend.toFixed(1)} /${this.temps.hotendTarget.toFixed(1)} B:${this.temps.bed.toFixed(1)} /${this.temps.bedTarget.toFixed(1)} @:0 B@:0`;
            case 'M114':
                return `ok X:${this.pos.x.toFixed(2)} Y:${this.pos.y.toFixed(2)} Z:${this.pos.z.toFixed(2)} E:${this.state.e.toFixed(2)}`;
            case 'M119': {
                const xStr = this.pos.x <= 0.1 ? 'TRIGGERED' : 'open';
                const yStr = this.pos.y <= 0.1 ? 'TRIGGERED' : 'open';
                const zStr = this.pos.z <= 0.1 ? 'TRIGGERED' : 'open';
                return `Reporting endstop status\nx_min: ${xStr}\ny_min: ${yStr}\nz_min: ${zStr}\nok`;
            }
            case 'M106':
                // Standard Marlin: S is 0-255. Convert to 0.0-1.0 for frontend
                this.fanSpeed = words.S !== undefined ? Math.min(1.0, Math.max(0, words.S / 255)) : 1.0;
                return 'ok';
            case 'M107':
                this.fanSpeed = 0;
                return 'ok';
            case 'M220':
                // Speed factor percentage
                if (words.S !== undefined) this.speedFactor = words.S / 100;
                return 'ok';
            case 'M221':
                // Flow factor percentage
                if (words.S !== undefined) this.flowFactor = words.S / 100;
                return 'ok';

            case 'M112':
                this.halted = true;
                this.temps.hotendTarget = 0;
                this.temps.bedTarget = 0;
                return 'ok';
            case 'M999':
                this.halted = false;
                return 'ok';
            case 'M115':
                return "ok FIRMWARE_NAME:Marlin 2.1 Simulated SOURCE_CODE_URL:github.com PROTOCOL_VERSION:1.0 MACHINE_TYPE:3D Printer EXTRUDER_COUNT:1";
            case 'M503':
                return "echo:Steps per unit:\necho:  M92 X80.00 Y80.00 Z400.00 E93.00\nok";
            default:
                return 'ok';
        }
    }
}