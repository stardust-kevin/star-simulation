import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrinterCore } from './sim/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const core = new PrinterCore();
const sseClients = new Set();

const TCP_PORT = 8888;
const HTTP_PORT = 3001;
const TICK_MS = 100;

// ---------------------------------------------------------------------------
// Tick: advance the executor (queued motion) and thermal model, then push a
// full state snapshot to every browser.
// ---------------------------------------------------------------------------
setInterval(() => {
    const dtWall = TICK_MS / 1000;
    core.executor.tick(dtWall);
    const simDt = dtWall * core.executor.speedFactor;
    core.tickThermal(simDt);
    broadcast('state', core.snapshot());
}, TICK_MS);

// ---------------------------------------------------------------------------
// Helper: Align multi-line responses for clean console logging.
// ---------------------------------------------------------------------------
function logAligned(prefix, response) {
    const lines = response.split('\n');
    console.log(prefix + lines[0]);
    const padding = ' '.repeat(prefix.length);
    for (let i = 1; i < lines.length; i++) {
        console.log(padding + lines[i]);
    }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
    if (req.url === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    if (req.method === 'POST' && req.url === '/command') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const cmdStr = JSON.parse(body).line;
                const lines = String(cmdStr).split('\n');
                const results = [];

                for (const rawLine of lines) {
                    const clean = rawLine.trim();
                    if (!clean) continue;

                    console.log('[WEB] <- ' + clean);
                    const parsed = core.parseGCodeLine(clean);

                    if (parsed && !core.isImmediateCommand(parsed.command)) {
                        core.executor.enqueueLine(parsed, clean, 0, null);
                        results.push('ok');
                    } else {
                        const response = core.executeLine(clean);
                        results.push(response);
                        if (response !== 'ok' && response !== 'wait') {
                            logAligned('[WEB] -> ', response);
                            broadcast('response', { line: clean, response });
                        }
                    }

                    broadcast('gcode', { line: clean, source: 'web' });
                }

                broadcast('state', core.snapshot());
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', results }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error' }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/load') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const gcode = JSON.parse(body).gcode;
                const total = core.executor.load(gcode);
                console.log('[WEB] /load ' + total + ' segments queued');
                broadcast('state', core.snapshot());
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', totalSegments: total }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error' }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/control') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                core.executor.control(payload.action, payload.value);
                broadcast('state', core.snapshot());
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error' }));
            }
        });
        return;
    }

    const filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        const ext = path.extname(filePath);
        const mime = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json'
        }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(content);
    });
});

server.listen(HTTP_PORT, () => console.log('[HTTP] Ready on ' + HTTP_PORT));

function broadcast(event, data) {
    const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const c of sseClients) {
        try { c.write(payload); } catch (_) { /* ignore broken pipe */ }
    }
}

// ---------------------------------------------------------------------------
// TCP session
// ---------------------------------------------------------------------------
class TcpSession {
    constructor(socket) {
        this.socket = socket;
        this.buffer = '';
        this._closed = false;
    }

    attach() {
        console.log('[TCP] Host connected');
        this.socket.on('data', (chunk) => this._onData(chunk));
        this.socket.on('close', () => {
            this._closed = true;
            console.log('[TCP] Host disconnected');
        });
        this.socket.on('error', (err) => {
            this._closed = true;
            console.error('[TCP] Error: ' + err.message);
        });
    }

    _onData(chunk) {
        this.buffer += chunk.toString();
        const parts = this.buffer.split('\n');
        this.buffer = parts.pop();
        for (const part of parts) {
            const line = part.trim();
            if (line) this._processLine(line);
        }
    }

    _processLine(cmd) {
        console.log('[TCP] <- ' + cmd);

        try {
            const parsed = core.parseGCodeLine(cmd);
            if (!parsed) { this._write('ok'); return; }

            broadcast('gcode', { line: cmd, source: 'tcp' });

            // 1. Immediate commands (e.g., M114, M105)
            if (core.isImmediateCommand(parsed.command)) {
                const response = core.executeLine(cmd);
                if (response !== 'ok') {
                    logAligned('[TCP] -> ', response);
                    broadcast('response', { line: cmd, response });
                }
                this._write(response);
                broadcast('state', core.snapshot());
                return;
            }

            // 2. Blocking commands (M109 / M190)
            if (parsed.command === 'M109' || parsed.command === 'M190') {
                this._write('busy: processing');
                const onComplete = (response) => {
                    if (this._closed) return;
                    const resp = response || 'ok';
                    this._write(resp);
                    broadcast('state', core.snapshot());
                };
                core.executor.enqueueLine(parsed, cmd, 0, onComplete);
                return;
            }

            // 3. Queued Motion commands (G0, G1, G2, G3, etc.)
            // Send 'ok' IMMEDIATELY before processing the movement.
            this._write('ok');
            broadcast('state', core.snapshot());

            // Enqueue locally and let the executor handle it in the background
            core.executor.enqueueLine(parsed, cmd, 0, null);

        } catch (err) {
            console.error('[TCP] Internal Error while processing:', err);
            this._write('error:Internal Server Error');
        }
    }

    _write(text) {
        if (this._closed || !this.socket.writable) {
            console.log(`[TCP] (Skipped write to disconnected host): ${text}`);
            return;
        }
        // Log BEFORE writing so we can see exactly what is being sent
        if (text === 'ok') {
            console.log('[TCP] -> ok');
        } else if (text !== 'busy: processing') {
            logAligned('[TCP] -> ', text);
        }

        this.socket.write(text + '\n');
    }
}

const tcpServer = net.createServer((socket) => {
    const session = new TcpSession(socket);
    session.attach();
});

tcpServer.listen(TCP_PORT, () => console.log('[TCP] Ready on ' + TCP_PORT));