'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT     = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'index.html');

// AI key from environment variable (set in Railway dashboard)
let AI_KEY = process.env.FS_AI_KEY || '';

// Try .env file as fallback (local dev)
if (!AI_KEY) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const m = env.match(/FS_AI_KEY\s*=\s*(.+)/);
    if (m) AI_KEY = m[1].trim();
  } catch (_) {}
}

// ── CORS headers on every response ───────────────────────────
function headers(extra = {}) {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, ...headers() });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end',  () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ── Data persistence ──────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); return true; } catch { return false; }
}

// ── Gemini proxy ──────────────────────────────────────────────
function geminiPost(key, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Router ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // Serve the app
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    } catch {
      return send(res, 404, '"index.html not found"');
    }
  }

  // Health / ping
  if (req.method === 'GET' && pathname === '/api/ping') {
    return send(res, 200, { ok: true, hasAI: !!AI_KEY, ts: Date.now() });
  }

  // Load project data
  if (req.method === 'GET' && pathname === '/api/data') {
    const d = loadData();
    return d ? send(res, 200, d) : send(res, 404, { error: 'No data yet' });
  }

  // Save project data
  if (req.method === 'POST' && pathname === '/api/data') {
    const body = await readBody(req);
    return send(res, saveData(body) ? 200 : 500, { ok: saveData(body) });
  }

  // AI key status
  if (req.method === 'GET' && pathname === '/api/ai/status') {
    return send(res, 200, { hasKey: !!AI_KEY });
  }

  // Set AI key at runtime
  if (req.method === 'POST' && pathname === '/api/ai/key') {
    const body = await readBody(req);
    const key = (body.key || '').trim();
    if (!key.startsWith('AIza')) return send(res, 400, { error: 'Invalid key' });
    AI_KEY = key;
    try {
      const env = `FS_AI_KEY=${key}\n`;
      fs.writeFileSync(path.join(__dirname, '.env'), env);
    } catch (_) {}
    return send(res, 200, { ok: true });
  }

  // AI proxy — all AI calls go through here
  if (req.method === 'POST' && pathname === '/api/ai') {
    if (!AI_KEY) return send(res, 400, { error: 'No AI key configured on server. Add FS_AI_KEY in Railway environment variables.' });

    const body = await readBody(req);
    const { messages = [], system = '', context = '' } = body;

    const systemText = system || `You are FlowState AI, an expert Senior Engineering Project Manager for UK contractors specialising in data centre construction, power pods, LV/MV switchgear, and factory-to-handover production management. Answer precisely. Use UK English.\n\nLIVE PROJECT DATA:\n${context}`;

    // Build Gemini contents
    const contents = messages.slice(-12).map(m => ({
      role:  m.role === 'assistant' || m.role === 'ai' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    if (!contents.length || contents[contents.length - 1].role !== 'user') {
      return send(res, 400, { error: 'Last message must be from user' });
    }

    try {
      const r = await geminiPost(AI_KEY, {
        system_instruction:   { parts: [{ text: systemText }] },
        contents,
        generationConfig: { maxOutputTokens: 1200, temperature: 0.35 },
      });

      if (r.status !== 200) {
        let err = {};
        try { err = JSON.parse(r.body); } catch {}
        if (r.status === 400 || r.status === 403) {
          AI_KEY = ''; // invalidate bad key
        }
        return send(res, r.status, { error: err?.error?.message || `Gemini HTTP ${r.status}` });
      }

      const d = JSON.parse(r.body);
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
      return send(res, 200, { text });

    } catch (e) {
      return send(res, 500, { error: 'AI proxy error: ' + e.message });
    }
  }

  return send(res, 404, { error: 'Not found: ' + pathname });
});

server.listen(PORT, () => {
  console.log('\n  ┌──────────────────────────────────────────────┐');
  console.log(`  │  FlowState Engineering — Live on :${PORT}       │`);
  console.log(`  │  AI: ${AI_KEY ? '✅ Key configured' : '⚠️  No key — set FS_AI_KEY env var'}            │`);
  console.log(`  │  Data: ${require('fs').existsSync(DATA_FILE) ? '✅ data.json loaded' : '○  Fresh start'}             │`);
  console.log('  └──────────────────────────────────────────────┘\n');
  if (!AI_KEY) {
    console.log('  To enable AI:');
    console.log('  1. Get free key at https://aistudio.google.com/app/apikey');
    console.log('  2. In Railway: Settings → Variables → add FS_AI_KEY=your_key');
    console.log('  3. Redeploy (automatic)\n');
  }
});
