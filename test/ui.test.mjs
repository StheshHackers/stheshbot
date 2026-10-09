// Browser-behaviour tests: boots index.html in jsdom and drives the real UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFile } from 'node:fs/promises';

const HTML = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const LS_KEY = 'sthesh_state_v1';

const IGNORE = /Not implemented: navigation|Could not parse CSS stylesheet/;
const errors = [];

function boot({ seedLegacy } = {}) {
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(e));
    let html = HTML;
    if (seedLegacy) {
        html = html.replace('<body>', '<body><script>localStorage.setItem("sthesh_history", ' +
            JSON.stringify(JSON.stringify(seedLegacy)) + ');<\/script>');
    }
    const dom = new JSDOM(html, {
        url: 'http://localhost:3000/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole: vc
    });
    const w = dom.window;
    if (!w.TextDecoder) w.TextDecoder = TextDecoder;
    if (!w.AbortController) w.AbortController = AbortController;
    w.confirm = () => true;
    const mark = errors.length;
    const cleanup = () => {
        const unexpected = errors.slice(mark).filter((e) => !IGNORE.test(String(e && e.message)));
        try { w.close(); } catch { /* noop */ }
        assert.deepEqual(unexpected.map((e) => String(e && e.message)), [], 'unexpected page errors');
    };
    return { dom, w, cleanup };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonFetch(body, { ok = true, status = 200, calls = [] } = {}) {
    return async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        return {
            ok, status,
            headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
            json: async () => (typeof body === 'function' ? body(opts) : body)
        };
    };
}

function sseFetch(chunks, calls = []) {
    return async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        const parts = chunks.map((c) => new TextEncoder().encode(c));
        let i = 0;
        return {
            ok: true, status: 200,
            headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
            body: {
                getReader: () => ({
                    read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true, value: undefined })
                })
            }
        };
    };
}

function savedState(w) {
    return JSON.parse(w.localStorage.getItem(LS_KEY) || 'null');
}

/* ------------------------------------------------------------------ */
test('boots with welcome screen, chips and dark theme', () => {
    const { w, cleanup } = boot();
    const d = w.document;
    assert.ok(d.getElementById('welcome'), 'welcome screen shown for empty chat');
    assert.equal(d.querySelectorAll('.chip').length, 4);
    assert.equal(d.getElementById('chatList').children.length, 1);
    assert.equal(d.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(d.getElementById('voiceBtn').hidden, true, 'mic hidden when SpeechRecognition missing');
    assert.ok(d.getElementById('regenBtn').disabled, 'regenerate disabled with no answer');
    cleanup();
});

test('migrates the legacy single-thread history into a chat', () => {
    const { w, cleanup } = boot({
        seedLegacy: [{ type: 'bot', text: 'old greeting' }, { type: 'user', text: 'old question' }]
    });
    const d = w.document;
    assert.equal(d.getElementById('chatList').children.length, 1);
    assert.match(d.querySelector('.chat-item-title').textContent, /old question/);
    assert.equal(d.querySelectorAll('.msg').length, 2);
    assert.equal(w.localStorage.getItem('sthesh_history'), null, 'legacy key removed');
    cleanup();
});

test('markdown renders safely (XSS stripped, code/links/lists kept)', () => {
    const { w, cleanup } = boot();
    const md = w.renderMarkdown;

    const evil = md('<img src=x onerror=alert(1)> and <script>alert(2)</script>');
    assert.ok(!/<img|<script/i.test(evil), evil);
    assert.ok(evil.includes('&lt;img'), evil);

    const jsLink = md('[click](javascript:alert(1))');
    assert.ok(!/href="javascript/i.test(jsLink), jsLink);

    const doc = md('# Title\n- one\n- two\n\n1. first\n\n**bold** `code` [ok](https://x.dev)');
    assert.match(doc, /<h1>Title<\/h1>/);
    assert.match(doc, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(doc, /<ol><li>first<\/li><\/ol>/);
    assert.match(doc, /<strong>bold<\/strong>/);
    assert.match(doc, /<code>code<\/code>/);
    assert.match(doc, /<a href="https:\/\/x\.dev" target="_blank" rel="noopener noreferrer">ok<\/a>/);

    const block = md('```js\nconst a = "<b>";\n```');
    assert.match(block, /class="code-block"/);
    assert.ok(block.includes('&quot;&lt;b&gt;&quot;'), 'code content escaped, not executed');
    assert.match(block, /data-code="const a = &quot;&lt;b&gt;&quot;;"/);

    const partial = md('streaming now ```js\nconst x = 1');
    assert.match(partial, /class="code-block"/, 'unclosed fence still previews as code');

    const quote = md('> quoted line');
    assert.match(quote, /<blockquote>quoted line<\/blockquote>/);
    cleanup();
});

test('Enter sends a message, streams SSE, saves state and titles the chat', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    const calls = [];
    w.fetch = sseFetch([
        'data: {"del',
        'ta":"**Streamed"}\n\ndata: {"delta":" reply"}\n\n',
        'data: {"done":true,"text":"**Streamed** reply"}\n\n'
    ], calls);

    const input = d.getElementById('userInput');
    input.value = 'Hello there';
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    await sleep(200);
    const msgs = d.querySelectorAll('.msg');
    assert.equal(msgs.length, 2, 'user + bot');
    assert.equal(msgs[0].className, 'msg user');
    assert.equal(msgs[0].textContent.includes('Hello there'), true);
    const botHtml = msgs[1].querySelector('.msg-text').innerHTML;
    assert.match(botHtml, /<strong>Streamed<\/strong> reply/, botHtml);
    assert.ok(msgs[1].querySelector('.accuracy-tag'), 'accuracy tag present');
    assert.equal(d.getElementById('regenBtn').disabled, false, 'regenerate enabled after answer');

    assert.match(d.querySelector('.chat-item-title').textContent, /Hello there/, 'auto-titled from first message');

    const saved = savedState(w);
    assert.equal(saved.conversations[0].messages.length, 2);
    assert.equal(saved.conversations[0].messages[1].text, '**Streamed** reply');

    // payload sanity: multi-turn history + identity + stream flag
    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0].opts.body);
    assert.equal(payload.prompt, 'Hello there');
    assert.equal(payload.stream, true);
    assert.match(payload.developerInfo, /Athabile Dinilanga/);
    assert.ok(Array.isArray(payload.messages));
    cleanup();
});

test('non-JSON-shaped legacy responses and plain JSON both work', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    w.fetch = jsonFetch({ candidates: [{ content: { parts: [{ text: 'legacy shape' }] } }] });
    d.getElementById('userInput').value = 'ping';
    d.getElementById('sendBtn').click();
    await sleep(120);
    assert.match(d.querySelector('.msg.bot .msg-text').textContent, /legacy shape/);

    w.fetch = jsonFetch({ text: 'new shape' });
    d.getElementById('newChatBtn').click();
    await sleep(10);
    d.getElementById('userInput').value = 'pong';
    d.getElementById('sendBtn').click();
    await sleep(120);
    assert.match(d.querySelector('.msg.bot .msg-text').textContent, /new shape/);
    assert.equal(d.querySelectorAll('.msg').length, 2, 'fresh chat only has its own messages');
    cleanup();
});

test('server error shows a retry button; retry recovers', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    w.fetch = jsonFetch({ error: 'Boom server' }, { ok: false, status: 500 });
    d.getElementById('userInput').value = 'hi';
    d.getElementById('sendBtn').click();
    await sleep(120);

    const bot = d.querySelector('.msg.bot');
    assert.ok(bot.classList.contains('error'), 'error styling applied');
    assert.match(bot.textContent, /Boom server/);
    const retry = bot.querySelector('[data-action="resend"]');
    assert.ok(retry, 'retry button rendered');

    w.fetch = jsonFetch({ text: 'fixed answer' });
    retry.click();
    await sleep(150);
    const after = d.querySelector('.msg.bot');
    assert.ok(!after.classList.contains('error'), 'error cleared after retry');
    assert.match(after.textContent, /fixed answer/);
    assert.equal(d.querySelectorAll('.msg').length, 2, 'no duplicate messages after retry');
    cleanup();
});

test('stop button aborts generation without marking an error', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    w.fetch = (url, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
        });
    });

    d.getElementById('userInput').value = 'long question';
    d.getElementById('sendBtn').click();
    await sleep(60);

    const send = d.getElementById('sendBtn');
    assert.ok(send.classList.contains('stop'), 'send button becomes stop while generating');
    send.click(); // stop
    await sleep(120);

    assert.ok(!send.classList.contains('stop'), 'send button restored');
    const bot = d.querySelector('.msg.bot');
    assert.ok(!bot.classList.contains('error'), 'abort is not an error');
    assert.equal(d.querySelectorAll('.msg').length, 2);
    cleanup();
});

test('multi-chat: create, switch, rename, delete', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    w.fetch = jsonFetch({ text: 'first chat answer' });
    d.getElementById('userInput').value = 'remember me';
    d.getElementById('sendBtn').click();
    await sleep(120);
    assert.ok(d.querySelector('.msg.bot'), 'chat 1 has its answer');

    d.getElementById('newChatBtn').click();
    assert.equal(d.getElementById('chatList').children.length, 2, 'second chat created');
    assert.ok(d.getElementById('welcome'), 'new chat is empty');
    assert.equal(d.querySelectorAll('.msg').length, 0);

    // switch back to the first chat
    d.getElementById('chatList').children[1].click();
    assert.equal(d.querySelectorAll('.msg').length, 2, 'messages restored when switching back');
    assert.match(d.getElementById('chatSubtitle').textContent, /remember me/);

    // rename via double-click -> input -> Enter
    const item = d.getElementById('chatList').children[1];
    item.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    const rename = d.querySelector('.rename-input');
    assert.ok(rename, 'rename input appears');
    rename.value = 'Renamed chat';
    rename.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(d.querySelectorAll('.chat-item-title')[1].textContent, 'Renamed chat');
    assert.equal(savedState(w).conversations[1].title, 'Renamed chat');

    // delete the empty chat (confirm stubbed true)
    d.getElementById('chatList').children[0].querySelector('[data-act="delete"]').click();
    assert.equal(d.getElementById('chatList').children.length, 1, 'chat deleted');
    assert.equal(d.querySelectorAll('.msg').length, 2, 'surviving chat keeps messages');
    cleanup();
});

test('regenerate replaces the last answer instead of appending', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    let request = 0;
    const payloads = [];
    w.fetch = async (url, opts) => {
        const idx = request++;
        const p = JSON.parse(opts.body);
        payloads.push(p);
        const text = idx === 0 ? 'answer v1' : idx === 1 ? 'answer v1b' : 'answer v2';
        return {
            ok: true, status: 200,
            headers: { get: () => 'application/json; charset=utf-8' },
            json: async () => ({ text })
        };
    };

    d.getElementById('userInput').value = 'q1';
    d.getElementById('sendBtn').click();
    await sleep(120);
    d.getElementById('userInput').value = 'q2';
    d.getElementById('sendBtn').click();
    await sleep(120);
    assert.equal(d.querySelectorAll('.msg').length, 4, 'two full turns');

    d.getElementById('regenBtn').click();
    await sleep(150);
    const msgs = d.querySelectorAll('.msg');
    assert.equal(msgs.length, 4, 'still exactly two turns after regenerate');
    assert.match(msgs[3].textContent, /answer v2/, 'fresh answer rendered');

    assert.equal(payloads.length, 3);
    const last = payloads[2];
    assert.equal(last.prompt, 'q2', 'regenerate resends the last user message');
    assert.deepEqual(last.messages, [
        { role: 'user', text: 'q1' },
        { role: 'model', text: 'answer v1' }
    ], 'earlier turns kept as context');
    cleanup();
});

test('image attachment flows into the request payload', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    const calls = [];
    w.fetch = jsonFetch({ text: 'I see a picture' }, { calls });

    const fileInput = d.getElementById('fileInput');
    const file = new w.File(['fake-png-bytes'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(80);

    assert.equal(d.querySelectorAll('.thumb-wrap').length, 1, 'preview thumbnail rendered');
    assert.ok(d.getElementById('attachPreviews').classList.contains('show'));

    d.getElementById('userInput').value = 'what is this?';
    d.getElementById('sendBtn').click();
    await sleep(150);

    const payload = JSON.parse(calls[0].opts.body);
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].mime, 'image/png');
    assert.equal(payload.attachments[0].data, Buffer.from('fake-png-bytes').toString('base64'));

    const userMsg = d.querySelector('.msg.user');
    assert.match(userMsg.textContent, /pic\.png/, 'file name shown on the message');
    assert.equal(d.querySelectorAll('.thumb-wrap').length, 0, 'previews cleared after send');
    assert.equal(savedState(w).conversations[0].messages[0].attachments[0].name, 'pic.png');
    assert.equal(JSON.stringify(savedState(w)).includes('fake-png-bytes'), false, 'image bytes never persisted to localStorage');
    cleanup();
});

test('theme toggle switches and persists', () => {
    const { w, cleanup } = boot();
    const d = w.document;
    d.getElementById('themeBtn').click();
    assert.equal(d.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(savedState(w).theme, 'light');
    d.getElementById('themeBtn').click();
    assert.equal(d.documentElement.getAttribute('data-theme'), 'dark');
    cleanup();
});

test('export downloads the active chat as Markdown', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    w.fetch = jsonFetch({ text: 'exportable answer' });
    d.getElementById('userInput').value = 'export me';
    d.getElementById('sendBtn').click();
    await sleep(120);

    const downloads = [];
    w.URL.createObjectURL = () => 'blob:mock';
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
    d.getElementById('exportBtn').click();

    assert.equal(downloads.length, 1);
    assert.match(downloads[0], /^stheshbot-.*\.md$/);
    assert.match(d.getElementById('toasts').textContent, /exported/i);
    cleanup();
});

test('copy button copies message text', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    let copied = null;
    Object.defineProperty(w.navigator, 'clipboard', {
        value: { writeText: async (t) => { copied = t; } },
        configurable: true
    });
    w.fetch = jsonFetch({ text: 'copy me **please**' });
    d.getElementById('userInput').value = 'copy request';
    d.getElementById('sendBtn').click();
    await sleep(120);

    d.querySelector('.msg.bot [data-action="copy-msg"]').click();
    await sleep(20);
    assert.equal(copied, 'copy me **please**');
    cleanup();
});

test('health check reflects a missing API key', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    w.fetch = jsonFetch({ ok: true, model: 'gemini-2.5-flash', configured: false });
    await w.checkHealth();
    assert.match(d.getElementById('statusText').textContent, /no API key/i);
    assert.ok(d.getElementById('statusDot').classList.contains('offline'));

    w.fetch = jsonFetch({ ok: true, model: 'gemini-2.5-flash', configured: true });
    await w.checkHealth();
    assert.match(d.getElementById('statusText').textContent, /Online/);
    assert.equal(d.getElementById('statusDot').classList.contains('offline'), false);
    cleanup();
});

test('clear wipes every conversation', async () => {
    const { w, cleanup } = boot();
    const d = w.document;
    w.fetch = jsonFetch({ text: 'to be wiped' });
    d.getElementById('userInput').value = 'temporary';
    d.getElementById('sendBtn').click();
    await sleep(120);
    assert.equal(d.querySelectorAll('.msg').length, 2);

    d.getElementById('clearBtn').click();
    await sleep(20);
    assert.equal(d.querySelectorAll('.msg').length, 0, 'back to empty welcome');
    assert.equal(d.getElementById('chatList').children.length, 1);
    assert.ok(savedState(w));
    cleanup();
});
