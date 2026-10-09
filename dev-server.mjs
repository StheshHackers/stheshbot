// Local dev/preview server for Stheshbot AI.
//   node dev-server.mjs            -> serves the site on :3000 with a MOCK /api/chat
//   GEMINI_API_KEY=... node dev-server.mjs   -> real Gemini answers through the same api/chat.js
// This mirrors Vercel's handler contract (req.body + res.status().json()/streaming).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);

const handler = (await import('./api/chat.js')).default;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8'
};

function sendJson(res, code, obj) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > 12 * 1024 * 1024) { req.destroy(); resolve(null); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => resolve(null));
    });
}

function mockReply(body) {
    const turns = Array.isArray(body.messages) ? body.messages.length : 0;
    const imgs = Array.isArray(body.attachments) ? body.attachments.length : 0;
    return [
        '## Demo mode',
        '',
        'The **mock backend** answered because `GEMINI_API_KEY` is not set on this server.',
        '',
        'Your prompt:',
        '',
        '> ' + String(body.prompt || '(image only)').replace(/\n/g, '\n> '),
        '',
        'What I can see about this request:',
        '',
        '- Conversation turns sent for context: **' + turns + '**',
        '- Image attachments: **' + imgs + '**',
        '- Streaming: **' + (body.stream ? 'yes' : 'no') + '**',
        '',
        '```js',
        '// Run with a real key to talk to Gemini:',
        'GEMINI_API_KEY=your_key node dev-server.mjs',
        '```'
    ].join('\n');
}

async function mockChat(req, res, body) {
    if (body.stream) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        });
        const parts = mockReply(body).match(/[\s\S]{1,24}/g) || [];
        for (const part of parts) {
            res.write('data: ' + JSON.stringify({ delta: part }) + '\n\n');
            await new Promise((r) => setTimeout(r, 45));
        }
        res.write('data: ' + JSON.stringify({ done: true, text: mockReply(body) }) + '\n\n');
        res.end();
        return;
    }
    sendJson(res, 200, { text: mockReply(body), finishReason: 'STOP' });
}

async function handleApi(req, res) {
    if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, model: 'gemini-2.5-flash', configured: HAS_KEY, mock: !HAS_KEY });
        return;
    }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'Only GET or POST is allowed.' }); return; }

    const raw = await readBody(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    req.body = body;

    if (!HAS_KEY) { await mockChat(req, res, body); return; }

    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => sendJson(res, res.statusCode || 200, obj);
    await handler(req, res);
}

async function handleStatic(req, res) {
    let pathname = '/';
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { /* keep default */ }
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const target = join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!target.startsWith(ROOT)) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    try {
        const data = await readFile(target);
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME[extname(target).toLowerCase()] || 'application/octet-stream');
        res.end(data);
    } catch {
        sendJson(res, 404, { error: 'Not found' });
    }
}

createServer(async (req, res) => {
    try {
        if (req.url && req.url.startsWith('/api/')) await handleApi(req, res);
        else await handleStatic(req, res);
    } catch (err) {
        console.error('[dev-server]', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Dev server error' });
        else try { res.end(); } catch { /* already closed */ }
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Stheshbot dev server -> http://0.0.0.0:${PORT}  (API: ${HAS_KEY ? 'real Gemini' : 'MOCK (no GEMINI_API_KEY)'})`);
});
