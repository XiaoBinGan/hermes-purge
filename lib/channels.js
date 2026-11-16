'use strict';
/** lib/channels.js — 两条模型通道的唯一实现 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const core = require('./core');

const PAYLOAD = path.join(__dirname, '..', 'payload');

/* ── 直连模型 ── */
async function viaApi({ root, prompt, nudge, opener, maxTokens = 16000 }) {
  const cfg = core.readHermesConfig(root);
  if (!cfg.key) throw new Error('config.yaml 里没有 api_key');

  const soul = fs.existsSync(path.join(PAYLOAD, 'SOUL.md'))
    ? fs.readFileSync(path.join(PAYLOAD, 'SOUL.md'), 'utf8') : '';

  const messages = [];
  if (soul) {
    messages.push({ role: 'user', content: soul });
    messages.push({ role: 'assistant', content: '明白。' });
  }
  messages.push({ role: 'user', content: prompt + nudge });
  if (opener) messages.push({ role: 'assistant', content: opener });

  const body = { model: cfg.model, messages, max_tokens: maxTokens };
  const res = await fetch(cfg.base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(900000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 160));
  }
  const j = await res.json();
  const c = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return core.concatOpener(opener, c);
}

/* ── dashboard 通道（JSON-RPC over WebSocket）── */
async function dashAlive(base) {
  try {
    const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

async function dashToken(base) {
  const html = await (await fetch(base + '/', { signal: AbortSignal.timeout(10000) })).text();
  const m = html.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/);
  if (!m) throw new Error('拿不到 dashboard token（页面结构可能变了）');
  return m[1];
}

async function viaDash({ base, prompt, nudge, opener, timeoutMs = 600000, token, source }) {
  const tok = token || process.env.HERMES_TOKEN || await dashToken(base);
  const full = prompt + nudge + (opener ? '\n\n' + opener : '');
  // source: 'desktop' 让 gateway 给这个会话挂上同桌面端一致的 surface
  // （_resolve_session_source → platform=desktop → toolsets {project, desktop_ui}）
  const createParams = source ? { source } : {};

  return await new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(tok)}`);
    } catch (e) { reject(e); return; }

    let buf = '', id = 0, sid = null, sent = false, done = false;
    const finish = (v) => { if (done) return; done = true; try { ws.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish(buf || '__WS_TIMEOUT__'), timeoutMs);
    const send = (m, p) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: m, params: p || {} }));
    const reply = (m) => { try { ws.send(JSON.stringify(m)); return true; } catch { return false; } };

    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS 连接失败')); });
    ws.addEventListener('close', (e) => { clearTimeout(timer); if (!done) finish(buf || `__WS_CLOSE_${e.code}__`); });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.result && m.result.session_id && !sid) sid = m.result.session_id;
      if (m.error) { clearTimeout(timer); finish('__RPC_ERROR__ ' + JSON.stringify(m.error).slice(0, 120)); return; }
      if (m.method !== 'event') return;
      const ty = (m.params || {}).type || '';
      const pl = (m.params || {}).payload || {};
      if (ty === 'gateway.ready' && !sent) {
        sent = true;
        send('session.create', createParams);
        setTimeout(() => send('prompt.submit', { text: full, session_id: sid }), 1600);
        return;
      }
      if (ty === 'message.delta') { buf += pl.text || pl.delta || ''; return; }
      if (ty === 'message.complete') {
        if (pl.text && buf.length < 20) buf = pl.text;
        clearTimeout(timer);
        finish(core.concatOpener(opener, buf));
      }
    });
  });
}

/* ── 走 hermes -z 子进程（带工具，会写盘）── */
function viaHermesBin({ root, prompt, nudge, opener, timeoutMs = 1800000 }) {
  const bin = core.resolveHermesBin(root);
  const env = { ...process.env, HERMES_HOME: root };
  if (opener) {
    const pf = path.join(PAYLOAD, '.runtime-prefill.json');
    const base = JSON.parse(fs.readFileSync(path.join(PAYLOAD, 'prefill_messages.json'), 'utf8'));
    fs.writeFileSync(pf, JSON.stringify([...base, { role: 'assistant', content: opener }], null, 2), 'utf8');
    env.HERMES_PREFILL_MESSAGES_FILE = pf;
  }
  const r = spawnSync(bin, ['-z', prompt + nudge], {
    env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return core.concatOpener(opener, ((r.stdout || '') + (r.stderr || '')).trim());
}

module.exports = { viaApi, viaDash, viaHermesBin, dashAlive, dashToken };
