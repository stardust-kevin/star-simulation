import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrinterCore } from './sim/core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TCP_PORT = 8888;
const HTTP_PORT = 3001;

const core = new PrinterCore();
const sseClients = new Set();

setInterval(() => { core.tickThermal(0.1); }, 100);

const server = http.createServer((req, res) => {
    if (req.url === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // Serve files from public directory
    const filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
        } else {
            const ext = path.extname(filePath);
            const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(content);
        }
    });
});

server.listen(HTTP_PORT, () => console.log(`[HTTP] Server running at http://localhost:${HTTP_PORT}`));

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(payload);
}

const tcpServer = net.createServer((socket) => {
    console.log(`[TCP] Host connected`);
    let buffer = '';
    let isWaitingTemp = false;

    socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            const cmd = line.trim();
            if (!cmd) continue;

            console.log(`[TCP] <- ${cmd}`);
            
            if (isWaitingTemp) {
                socket.write('busy: processing\n');
                continue;
            }

            const response = core.processTCPCommand(cmd);
            broadcast('gcode', { line: cmd });

            if (response === 'wait') {
                isWaitingTemp = true;
                const checkInterval = setInterval(() => {
                    if (core.isTempWaitDone()) {
                        clearInterval(checkInterval);
                        isWaitingTemp = false;
                        socket.write('ok\n');
                        console.log(`[TCP] -> ok (Temp reached)`);
                    }
                }, 100);
            } else {
                socket.write(response + '\n');
                console.log(`[TCP] -> ${response.split('\n')[0]}`);
            }
        }
    });

    socket.on('close', () => console.log(`[TCP] Host disconnected`));
    socket.on('error', (err) => console.error(`[TCP] Error:`, err.message));
});

tcpServer.listen(TCP_PORT, () => console.log(`[TCP] Printer listening on port ${TCP_PORT}`));
