// Stheshbot AI - serverless chat endpoint (Vercel Node function)
// POST /api/chat  -> non-streaming JSON or streaming SSE (when body.stream === true)
// GET  /api/chat  -> tiny health/status payload for the UI status light

const MODEL = "gemini-2.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const LIMITS = {
    promptChars: 32_000,
    developerChars: 8_000,
    historyMessages: 24,
    historyChars: 8_000,
    attachments: 3,
    attachmentBytes: 3.5 * 1024 * 1024, // stay under Vercel's 4.5 MB request body cap
    requestsPerWindow: 30,
    windowMs: 60_000,
    upstreamTimeoutMs: 60_000,
};

// ---------------------------------------------------------------- rate limit
// Best-effort, in-memory (resets per serverless instance) - it only softens abuse.
const buckets = new Map();

function rateLimitOk(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > LIMITS.windowMs) {
        bucket = { start: now, count: 0 };
        buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 5_000) {
        for (const [k, v] of buckets) {
            if (now - v.start > LIMITS.windowMs) buckets.delete(k);
        }
    }
    return bucket.count <= LIMITS.requestsPerWindow;
}

function clientIp(req) {
    const fwd = req.headers && req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
    return (req.socket && req.socket.remoteAddress) || "unknown";
}

// ---------------------------------------------------------------- helpers
function parseBody(req) {
    let body = req.body;
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = null; }
    }
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

function clip(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
}

function pushMessage(contents, role, parts) {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); // merge consecutive turns
    else contents.push({ role, parts });
}

function normalizeAttachments(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    let total = 0;
    for (const item of list.slice(0, LIMITS.attachments)) {
        if (!item || typeof item !== "object") continue;
        const mime = typeof item.mime === "string" ? item.mime : "";
        if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) continue;
        const data = typeof item.data === "string" ? item.data : "";
        if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
        const bytes = Math.floor((data.length * 3) / 4);
        if (bytes > LIMITS.attachmentBytes) continue;
        if (total + bytes > LIMITS.attachmentBytes) break; // whole request must fit the body cap
        total += bytes;
        out.push({ mime, data });
    }
    return out;
}

function buildContents(body) {
    const contents = [];

    if (Array.isArray(body.messages)) {
        for (const msg of body.messages.slice(-LIMITS.historyMessages)) {
            if (!msg || typeof msg !== "object") continue;
            const role = msg.role === "model" || msg.role === "bot" ? "model" : "user";
            const text = clip(msg.text, LIMITS.historyChars).trim();
            if (!text) continue;
            pushMessage(contents, role, [{ text }]);
        }
        // The API wants a user turn first; drop any leading model turns (e.g. the greeting).
        while (contents.length && contents[0].role === "model") contents.shift();
    }

    const prompt = clip(body.prompt, LIMITS.promptChars).trim();
    const attachments = normalizeAttachments(body.attachments);
    if (prompt || attachments.length) {
        const parts = [
            ...attachments.map((a) => ({ inline_data: { mime_type: a.mime, data: a.data } })),
            ...(prompt ? [{ text: prompt }] : []),
        ];
        pushMessage(contents, "user", parts);
    }

    return { contents, attachmentCount: attachments.length };
}

function extractText(data) {
    const candidates = data && Array.isArray(data.candidates) ? data.candidates : [];
    return candidates
        .map((c) => (c && c.content && Array.isArray(c.content.parts) ? c.content.parts : []))
        .flat()
        .map((p) => (p && typeof p.text === "string" ? p.text : ""))
        .join("");
}

function upstreamMessage(status, data) {
    if (data && data.error && data.error.message) return data.error.message;
    if (status === 429) return "Gemini is rate limiting requests right now. Try again shortly.";
    if (status === 401 || status === 403) return "The server's Gemini credentials were rejected.";
    return `Gemini request failed (HTTP ${status}).`;
}

function buildPayload(body) {
    const { contents, attachmentCount } = buildContents(body);
    if (!contents.length) {
        return { error: "Nothing to answer - send a prompt or a conversation history." };
    }
    const payload = { contents };
    const devInfo = clip(body.developerInfo, LIMITS.developerChars).trim();
    if (devInfo) payload.systemInstruction = { parts: [{ text: devInfo }] };
    return { payload, attachmentCount };
}

// ---------------------------------------------------------------- streaming
// Gemini's SSE chunks may be incremental or cumulative depending on the model;
// normalise both into plain {delta} events for the browser.
async function streamGemini(upstream, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line.startsWith("data:")) continue;
                const chunk = line.slice(5).trim();
                if (!chunk || chunk === "[DONE]") continue;
                let event;
                try { event = JSON.parse(chunk); } catch { continue; }
                if (event.error) {
                    send({ error: event.error.message || "Stream failed" });
                    res.end();
                    return;
                }
                const full = extractText(event);
                if (!full) continue;
                let delta;
                if (full.startsWith(accumulated) && full.length > accumulated.length) {
                    delta = full.slice(accumulated.length);
                    accumulated = full;
                } else {
                    delta = full;
                    accumulated += full;
                }
                if (delta) send({ delta });
                const finish = event.candidates && event.candidates[0] && event.candidates[0].finishReason;
                if (finish && finish !== "STOP") send({ notice: finish });
            }
        }
        send({ done: true, text: accumulated });
    } catch {
        try { send({ error: "Stream interrupted" }); } catch { /* connection already gone */ }
    }
    res.end();
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
    if (req.method === "GET") {
        const key = process.env.GEMINI_API_KEY;
        return res.status(200).json({ ok: true, model: MODEL, configured: Boolean(key) });
    }
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only GET or POST is allowed." });
    }

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        return res.status(500).json({
            error: "Server is missing the GEMINI_API_KEY environment variable.",
        });
    }
    if (!rateLimitOk(clientIp(req))) {
        return res.status(429).json({ error: "Too many requests - wait a minute and try again." });
    }

    const body = parseBody(req);
    const built = buildPayload(body);
    if (built.error) return res.status(400).json({ error: built.error });

    const wantsStream = body.stream === true;
    const endpoint = `${GEMINI_BASE}/${MODEL}:${wantsStream ? "streamGenerateContent?alt=sse&" : "generateContent?"}key=${API_KEY}`;

    let upstream;
    try {
        upstream = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(built.payload),
            signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs),
        });
    } catch {
        return res.status(502).json({ error: "Could not reach Gemini. Check the server's network." });
    }

    if (!upstream.ok) {
        const data = await upstream.json().catch(() => null);
        const status = upstream.status === 429 ? 429 : 502;
        return res.status(status).json({ error: upstreamMessage(upstream.status, data) });
    }

    if (wantsStream && upstream.body) {
        return streamGemini(upstream, res);
    }

    const data = await upstream.json().catch(() => null);
    if (!data) return res.status(502).json({ error: "Gemini returned an unreadable response." });

    const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
    if (blockReason) {
        return res.status(400).json({ error: `Request blocked by safety filters (${blockReason}).` });
    }

    const text = extractText(data);
    if (!text) {
        return res.status(502).json({ error: "Gemini returned an empty response. Try rephrasing." });
    }
    const candidate = data.candidates && data.candidates[0];
    return res.status(200).json({
        text,
        finishReason: candidate && candidate.finishReason,
        usage: data.usageMetadata,
        attachmentCount: built.attachmentCount,
    });
}
