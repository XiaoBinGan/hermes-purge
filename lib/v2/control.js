'use strict';
/**
 * lib/v2/control.js —— 桌面面板的本地控制服务
 *
 * 为什么需要它：面板跑在 Electron 的渲染进程里（沙箱、没有 node），
 * 它自己不能执行 `purge apply` / `purge revert`。所以给一个只监听 127.0.0.1 的
 * 小 HTTP 服务，面板带 token 调它，服务端再 fork 我们自己的 CLI 去做事 ——
 * 行为与命令行完全一致，不另写一套逻辑。
 *
 * 安全边界（写清楚）：
 *   - 只 bind 127.0.0.1
 *   - 每个请求必须带 `x-purge-token`，token 存在 `<state>/control.json`（0600）
 *   - 只允许白名单动作：apply / revert / verify / report
 *   - 不做鉴权以外的防护（同一个用户的本机进程本来就能直接跑 CLI）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ACTIONS = new Set(['apply', 'revert', 'verify', 'report']);

function stateFile(target) {
  return path.join(target, '.hermes-purge', 'v2', 'control.json');
}

function loadState(target) {
  try { return JSON.parse(fs.readFileSync(stateFile(target), 'utf8')); } catch (e) { return null; }
}

function saveState(target, st) {
  const f = stateFile(target);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(st, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch (e) { /* Windows 上无意义 */ }
  return st;
}

/** 取（或新建）token —— 面板安装时与 serve 启动时读的是同一份 */
function ensureState(target, opts) {
  const cur = loadState(target);
  const st = {
    token: (cur && cur.token) || crypto.randomBytes(24).toString('hex'),
    port: (opts && opts.port !== undefined && opts.port !== 0) ? opts.port : ((cur && cur.port) || 9123),
    target,
    updatedAt: new Date().toISOString(),
  };
  return saveState(target, st);
}

function runCli(cliPath, action, target) {
  const args = [cliPath];
  if (action === 'verify') args.push('verify', '--level=2');
  else if (action === 'report') args.push('report', '--out', path.join(target, 'purge-report.html'));
  else args.push(action);
  args.push('--target=' + target);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600000, windowsHide: true });
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  return { ok: r.status === 0, code: r.status, output: out.slice(-4000) };
}

/** 生成内联报告用的数据（不需要起服务也能读到最新状态） */
function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-purge-token, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * 起服务。onReady({port}) 用于打印；返回 server 便于测试关闭。
 * @param {object} o {target, cliPath, port, token}
 */
function start(o) {
  const target = o.target;
  const st = ensureState(target, { port: o.port });
  const token = o.token || st.token;
  // 注意用 !== undefined：测试里传 0 表示「随便分配端口」，不能被 || 吃掉
  const port = o.port === undefined ? st.port : o.port;

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.headers['x-purge-token'] !== token) return json(res, 401, { ok: false, error: 'bad-token' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, target, pid: process.pid, actions: [...ACTIONS] });
    }
    if (url.pathname === '/api/report') {
      const out = path.join(target, '.hermes-purge', 'v2', 'panel-report.html');
      // 注意：CLI 的参数是 --k=v 形式（--out 单独跟值不认）
      const r = spawnSync(process.execPath, [o.cliPath, 'report', '--out=' + out, '--target=' + target],
        { encoding: 'utf8', timeout: 120000, windowsHide: true });
      try {
        const html = fs.readFileSync(out, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'x-purge-token',
          'cache-control': 'no-store',
        });
        return res.end(html);
      } catch (e) {
        return json(res, 500, { ok: false, error: 'report-failed', detail: (r.stderr || '').slice(0, 300) });
      }
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let action = '';
        try { action = JSON.parse(body || '{}').action || ''; } catch (e) { /* 下面报错 */ }
        if (!ACTIONS.has(action)) return json(res, 400, { ok: false, error: 'bad-action' });
        const r = runCli(o.cliPath, action, target);
        return json(res, 200, Object.assign({ action }, r));
      });
      return;
    }
    return json(res, 404, { ok: false, error: 'not-found' });
  });

  server.listen(port, '127.0.0.1');
  if (o.onReady) server.on('listening', () => o.onReady(server.address().port));
  return { server, port, token, state: st };
}

module.exports = { start, ensureState, loadState, stateFile, ACTIONS };
