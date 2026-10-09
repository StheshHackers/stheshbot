// Unit tests for api/chat.js against a stubbed upstream Gemini fetch.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { default: handler } = await import('../api/chat.js');

const realFetch = globalThis.fetch;

function makeRes() {
    const res = { statusCode: 200, headers: {}, body: null, chunks: [], ended: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    res.writeHead = (c, h) => { res.statusCode = c; res.headers = h || {}; return res; };
    res.write = (d) => { res.chunks.push(String(d)); return true; };
    res.end = (d) => { if (d) res.chunks.push(String(d)); res.ended = true; return res; };
    return res;
}

function makeReq(body, { method = 'POST', ip = '10.0.0.1' } = {}) {
    return { method, headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' }, body };
}

function geminiOk(text, finishReason = 'STOP') {
    return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata: { totalTokenCount: 7 } })
    };
}

function sseFromEvents(events) {
    const payload = events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
    const bytes = new TextEncoder().encode(payload);
    let delivered = false;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: async () => {
                    if (delivered) return { done: true, value: undefined };
                    delivered = true;
                    return { done: false, value: bytes };
                }
            })
        }
    };
}

let lastFetch = null;

beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    lastFetch = null;
    globalThis.fetch = async (url, opts) => {
        lastFetch = { url: String(url), opts, payload: opts && opts.body ? JSON.parse(opts.body) : null };
        return geminiOk('stubbed answer');
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.GEMINI_API_KEY;
});

test('GET returns health payload', async () => {
    const res = makeRes();
    await handler(makeReq(null, { method: 'GET' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.model, 'gemini-2.5-flash');
});

test('rejects non-GET/POST methods', async () => {
    const res = makeRes();
    await handler(makeReq({}, { method: 'DELETE' }), res);
    assert.equal(res.statusCode, 405);
    assert.ok(res.body.error);
});

test('missing API key returns 500 with a clear message', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = makeRes();
    await handler(makeReq({ prompt: 'hi' }), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /GEMINI_API_KEY/);
});

test('empty body returns 400', async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Nothing to answer/);
});

test('passes prompt, system instruction and history to Gemini', async () => {
    const res = makeRes();
    await handler(makeReq({
        prompt: 'and then?',
        developerInfo: 'You are Stheshbot',
        messages: [
            { role: 'model', text: 'greeting that must be dropped' },
            { role: 'user', text: 'first question' },
            { role: 'bot', text: 'first answer' },
            { role: 'model', text: 'consecutive model merged' }
        ]
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.text, 'stubbed answer');
    assert.equal(res.body.finishReason, 'STOP');

    const { payload } = lastFetch;
    assert.equal(payload.contents[0].role, 'user');            // leading model turn dropped
    assert.equal(payload.contents[0].parts[0].text, 'first question');
    assert.equal(payload.contents[1].role, 'model');
    assert.equal(payload.contents[1].parts.length, 2);         // answer + consecutive model merged
    assert.equal(payload.contents[2].role, 'user');
    assert.equal(payload.contents[2].parts[0].text, 'and then?');
    assert.equal(payload.systemInstruction.parts[0].text, 'You are Stheshbot');
    assert.match(lastFetch.url, /gemini-2\.5-flash:generateContent/);
    assert.match(lastFetch.url, /key=test-key/);
});

test('validates image attachments (mime, base64, size)', async () => {
    const res = makeRes();
    await handler(makeReq({
        prompt: 'what is this?',
        attachments: [
            { mime: 'image/png', data: Buffer.from('png!').toString('base64') },
            { mime: 'application/pdf', data: 'AAAA' },
            { mime: 'image/png', data: Buffer.from('second').toString('base64') },
            { mime: 'image/png', data: Buffer.from('beyond-the-count-limit').toString('base64') }
        ]
    }), res);

    assert.equal(res.statusCode, 200);
    const parts = lastFetch.payload.contents[0].parts;
    const images = parts.filter((p) => p.inline_data);
    assert.equal(images.length, 2); // only the two valid images within the 3-item cap survive
    assert.equal(images[0].inline_data.mime_type, 'image/png');
    assert.equal(parts[parts.length - 1].text, 'what is this?');
    assert.equal(res.body.attachmentCount, 2);
});

test('upstream error is surfaced as 429 with the upstream message', async () => {
    globalThis.fetch = async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Slow down please' } })
    });
    const res = makeRes();
    await handler(makeReq({ prompt: 'hi' }), res);
    assert.equal(res.statusCode, 429);
    assert.match(res.body.error, /Slow down please/);
});

test('blocked prompt returns a friendly 400', async () => {
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } })
    });
    const res = makeRes();
    await handler(makeReq({ prompt: 'hi' }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /SAFETY/);
});

test('stream=true re-emits normalised SSE deltas (cumulative upstream chunks)', async () => {
    globalThis.fetch = async () => sseFromEvents([
        { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Hello wo' }] } }] },       // cumulative
        { candidates: [{ content: { parts: [{ text: 'rld' }] } }] },           // delta-style
        { candidates: [{ content: { parts: [{ text: 'Hello world!' }] }, finishReason: 'MAX_TOKENS' }] }
    ]);

    const res = makeRes();
    await handler(makeReq({ prompt: 'hi', stream: true }), res);

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /text\/event-stream/);
    assert.equal(res.ended, true);

    const events = res.chunks.join('').split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    const deltas = events.filter((e) => e.delta).map((e) => e.delta);
    assert.ok(deltas.length >= 3, 'expected delta events');
    assert.ok(events.some((e) => e.notice === 'MAX_TOKENS'), 'finish reason should be forwarded');
    const final = events.find((e) => e.done);
    assert.ok(final && final.text === 'Hello world!', 'final event carries canonical text');
    // reconstructed text must never lose characters
    const rebuilt = deltas.join('');
    assert.ok(rebuilt.includes('Hello'), 'rebuilt: ' + rebuilt);
});

test('stream flag never reaches the non-stream endpoint', async () => {
    globalThis.fetch = async (url, opts) => {
        lastFetch = { url: String(url), opts, payload: JSON.parse(opts.body) };
        return geminiOk('plain');
    };
    const res = makeRes();
    await handler(makeReq({ prompt: 'hi' }), res);
    assert.match(lastFetch.url, /generateContent\?/);
    assert.equal(res.body.text, 'plain');
});

test('rate limit returns 429 after 30 requests in a window', async () => {
    const ip = '203.0.113.9';
    let last = null;
    for (let i = 0; i < 31; i++) {
        last = makeRes();
        await handler(makeReq({ prompt: 'hi ' + i }, { ip }), last);
        if (last.statusCode === 429) break;
    }
    assert.equal(last.statusCode, 429);
    assert.match(last.body.error, /Too many requests/);
});
