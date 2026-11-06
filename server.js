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

// Push real-time state to the frontend every 100ms
setInterval(() => {
    core.tickThermal(0.1);
    broadcast('state', {
        hotend: core.temps.hotend, bed: core.temps.bed,
        targetHotend: core.temps.hotendTarget, targetBed: core.temps.bedTarget,
        x: core.pos.x, y: core.pos.y, z: core.pos.z,
        fanSpeed: core.fanSpeed, speedFactor: core.speedFactor, flowFactor: core.flowFactor
    });
}, 100);

const server = http.createServer((req, res) => {
    if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
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
                const lines = cmdStr.split('\n');

                for (const line of lines) {
                    const cleanLine = line.trim();
                    if (!cleanLine) continue;

                    // Print web command log
                    console.log(`[WEB] <- ${cleanLine}`);

                    const fromPos = { ...core.pos };
                    const response = core.processTCPCommand(cleanLine);
                    const toPos = { ...core.pos };

                    // Print web response log
                    if (response !== 'wait') {
                        console.log(`[WEB] -> ${response.replace(/\n/g, ' | ')}`);
                    }

                    // Broadcast to frontend
                    broadcast('gcode', { line: cleanLine, source: 'web' });
                    if (response !== 'ok' && response !== 'wait') {
                        broadcast('response', { line: cleanLine, response: response });
                    }

                    // Detect movement
                    if (fromPos.x !== toPos.x || fromPos.y !== toPos.y || fromPos.z !== toPos.z) {
                        broadcast('move', { from: fromPos, to: toPos });
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch (e) {
                res.writeHead(400);
                res.end('Bad Request');
            }
        });
        return;
    }

    const filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, content) => {
        if (err) { res.writeHead(404); res.end('Not Found'); }
        else {
            const ext = path.extname(filePath);
            const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(content);
        }
    });
});

server.listen(HTTP_PORT, () => console.log(`[HTTP] Ready on ${HTTP_PORT}`));

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(payload);
}

const tcpServer = net.createServer((socket) => {
    console.log(`[TCP] Host connected`);
    let buffer = '';

    socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            const cmd = line.trim();
            if (!cmd) continue;

            // Print TCP receive log
            console.log(`[TCP] <- ${cmd}`);

            const fromPos = { ...core.pos };
            const resp = core.processTCPCommand(cmd);
            const toPos = { ...core.pos };

            // Print TCP send log
            if (resp === 'wait') {
                console.log(`[TCP] -> busy: processing`);
                socket.write('busy: processing\n');
                // In a real implementation, M109/M190 should wait here.
                // For now, we assume immediate finish to prevent hanging.
                setTimeout(() => socket.write('ok\n'), 100);
            } else {
                console.log(`[TCP] -> ${resp.replace(/\n/g, ' | ')}`);
                socket.write(resp + '\n');
                broadcast('response', { line: cmd, response: resp });
            }

            broadcast('gcode', { line: cmd, source: 'tcp' });

            if (fromPos.x !== toPos.x || fromPos.y !== toPos.y || fromPos.z !== toPos.z) {
                broadcast('move', { from: fromPos, to: toPos });
            }
        }
    });

    socket.on('close', () => console.log(`[TCP] Host disconnected`));
    socket.on('error', (err) => console.error(`[TCP] Error:`, err.message));
});

tcpServer.listen(TCP_PORT, () => console.log(`[TCP] Ready on ${TCP_PORT}`));