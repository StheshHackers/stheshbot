// Stheshbot AI - Cloudflare Worker entrypoint (Sites deployment).
// Handles /api/chat (streaming + JSON) with env.GEMINI_API_KEY, then falls
// back to env.ASSETS for the static app. Mirrors the behaviour of api/chat.js.

const MODEL = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const LIMITS = {
    promptChars: 32000,
    developerChars: 8000,
    historyMessages: 24,
    historyChars: 8000,
    attachments: 3,
    attachmentBytes: 3.5 * 1024 * 1024,
    requestsPerWindow: 30,
    windowMs: 60000,
    upstreamTimeoutMs: 60000
};

/* ------------------------------ rate limit ------------------------------ */
const buckets = new Map();

function rateLimitOk(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > LIMITS.windowMs) {
        bucket = { start: now, count: 0 };
        buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 5000) {
        for (const [k, v] of buckets) {
            if (now - v.start > LIMITS.windowMs) buckets.delete(k);
        }
    }
    return bucket.count <= LIMITS.requestsPerWindow;
}

function clientIp(request) {
    return request.headers.get('cf-connecting-ip')
        || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
        || 'unknown';
}

/* ------------------------------ helpers -------------------------------- */
function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
}

function clip(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function pushMessage(contents, role, parts) {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
}

function normalizeAttachments(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    let total = 0;
    for (const item of list.slice(0, LIMITS.attachments)) {
        if (!item || typeof item !== 'object') continue;
        const mime = typeof item.mime === 'string' ? item.mime : '';
        if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) continue;
        const data = typeof item.data === 'string' ? item.data : '';
        if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
        const bytes = Math.floor((data.length * 3) / 4);
        if (bytes > LIMITS.attachmentBytes) continue;
        if (total + bytes > LIMITS.attachmentBytes) break;
        total += bytes;
        out.push({ mime, data });
    }
    return out;
}

function buildContents(body) {
    const contents = [];
    if (Array.isArray(body.messages)) {
        for (const msg of body.messages.slice(-LIMITS.historyMessages)) {
            if (!msg || typeof msg !== 'object') continue;
            const role = msg.role === 'model' || msg.role === 'bot' ? 'model' : 'user';
            const text = clip(msg.text, LIMITS.historyChars).trim();
            if (!text) continue;
            pushMessage(contents, role, [{ text }]);
        }
        while (contents.length && contents[0].role === 'model') contents.shift();
    }
    const prompt = clip(body.prompt, LIMITS.promptChars).trim();
    const attachments = normalizeAttachments(body.attachments);
    if (prompt || attachments.length) {
        const parts = [
            ...attachments.map((a) => ({ inline_data: { mime_type: a.mime, data: a.data } })),
            ...(prompt ? [{ text: prompt }] : [])
        ];
        pushMessage(contents, 'user', parts);
    }
    return { contents, attachmentCount: attachments.length };
}

function extractText(data) {
    const candidates = data && Array.isArray(data.candidates) ? data.candidates : [];
    return candidates
        .map((c) => (c && c.content && Array.isArray(c.content.parts) ? c.content.parts : []))
        .flat()
        .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
        .join('');
}

function upstreamMessage(status, data) {
    if (data && data.error && data.error.message) return data.error.message;
    if (status === 429) return 'Gemini is rate limiting requests right now. Try again shortly.';
    if (status === 401 || status === 403) return "The server's Gemini credentials were rejected.";
    return `Gemini request failed (HTTP ${status}).`;
}

/* ------------------------------ streaming ------------------------------ */
// Gemini SSE chunks may be cumulative or incremental; normalise to {delta}.
async function streamResponse(upstream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (obj) => writer.write(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'));

    (async () => {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (line.slice(0, 5) !== 'data:') continue;
                    const chunk = line.slice(5).trim();
                    if (!chunk || chunk === '[DONE]') continue;
                    let event;
                    try { event = JSON.parse(chunk); } catch { continue; }
                    if (event.error) {
                        await send({ error: event.error.message || 'Stream failed' });
                        await writer.close();
                        return;
                    }
                    const full = extractText(event);
                    if (full) {
                        let delta;
                        if (full.startsWith(accumulated) && full.length > accumulated.length) {
                            delta = full.slice(accumulated.length);
                            accumulated = full;
                        } else {
                            delta = full;
                            accumulated += full;
                        }
                        if (delta) await send({ delta });
                    }
                    const finish = event.candidates && event.candidates[0] && event.candidates[0].finishReason;
                    if (finish && finish !== 'STOP') await send({ notice: finish });
                }
            }
            await send({ done: true, text: accumulated });
            await writer.close();
        } catch {
            try { await send({ error: 'Stream interrupted' }); await writer.close(); } catch { /* gone */ }
        }
    })();

    return new Response(readable, {
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
        }
    });
}

/* ------------------------------ API ------------------------------------ */
async function handleApi(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/chat') {
        return json({ ok: true, model: MODEL, configured: Boolean(env.GEMINI_API_KEY) });
    }
    if (request.method !== 'POST') {
        return json({ error: 'Only GET or POST is allowed.' }, 405);
    }
    if (url.pathname !== '/api/chat') {
        return json({ error: 'Not found.' }, 404);
    }

    const API_KEY = env.GEMINI_API_KEY;
    if (!API_KEY) {
        return json({ error: 'Server is missing the GEMINI_API_KEY secret.' }, 500);
    }
    if (!rateLimitOk(clientIp(request))) {
        return json({ error: 'Too many requests - wait a minute and try again.' }, 429);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        body = {};
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

    const { contents, attachmentCount } = buildContents(body);
    if (!contents.length) {
        return json({ error: 'Nothing to answer - send a prompt or a conversation history.' }, 400);
    }

    const payload = { contents };
    const devInfo = clip(body.developerInfo, LIMITS.developerChars).trim();
    if (devInfo) payload.systemInstruction = { parts: [{ text: devInfo }] };

    const wantsStream = body.stream === true;
    const endpoint = `${GEMINI_BASE}/${MODEL}:${wantsStream ? 'streamGenerateContent?alt=sse&' : 'generateContent?'}key=${API_KEY}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIMITS.upstreamTimeoutMs);
    let upstream;
    try {
        upstream = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ctrl.signal
        });
    } catch {
        return json({ error: "Could not reach Gemini. Check the server's network." }, 502);
    } finally {
        clearTimeout(timer);
    }

    if (!upstream.ok) {
        const data = await upstream.json().catch(() => null);
        return json({ error: upstreamMessage(upstream.status, data) }, upstream.status === 429 ? 429 : 502);
    }

    if (wantsStream && upstream.body) {
        return streamResponse(upstream);
    }

    const data = await upstream.json().catch(() => null);
    if (!data) return json({ error: 'Gemini returned an unreadable response.' }, 502);

    const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
    if (blockReason) {
        return json({ error: `Request blocked by safety filters (${blockReason}).` }, 400);
    }
    const text = extractText(data);
    if (!text) return json({ error: 'Gemini returned an empty response. Try rephrasing.' }, 502);

    const candidate = data.candidates && data.candidates[0];
    return json({
        text,
        finishReason: candidate && candidate.finishReason,
        usage: data.usageMetadata,
        attachmentCount
    });
}

/* ------------------------------ router --------------------------------- */
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) {
            try {
                return await handleApi(request, env);
            } catch (err) {
                return json({ error: 'Worker error: ' + (err && err.message ? err.message : 'unknown') }, 500);
            }
        }
        return env.ASSETS.fetch(request);
    }
};
