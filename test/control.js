'use strict';
/**
 * test/control.js —— 桌面面板的本地控制服务
 *
 * 面板上的「启用 / 停用 / 体检 / 刷新」靠它执行，所以必须证明：
 *   1. 不带 token / token 错 → 401（只 bind 127.0.0.1，靠 token 防本机其他进程误调）
 *   2. 白名单动作才执行（别的 action 一律 400）
 *   3. 动作真的会跑 CLI，并返回输出（这里用一个假 CLI 脚本，不碰真机）
 *   4. /api/report 返回 HTML
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const control = require('../lib/v2/control');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-ctl-'));
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  \u2714 ' + name); } catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); } };

// 假 CLI：report 写文件，其它打印 ok / 或者按参数失败
const fakeCli = path.join(TMP, 'fake-cli.js');
fs.writeFileSync(fakeCli, `
const fs = require('fs');
const args = process.argv.slice(2);
const out = args.find(a => a.startsWith('--out='));
if (args[0] === 'report' && out) { fs.writeFileSync(out.slice(6), '<html>FAKE REPORT</html>'); process.exit(0); }
if (args[0] === 'revert') { console.log('reverted'); process.exit(0); }
if (args[0] === 'verify') { console.log('verify ok'); process.exit(0); }
console.log('apply ok'); process.exit(0);
`);

function req(port, p, opts) {
  return new Promise((resolve, reject) => {
    const r = http.request(Object.assign({ host: '127.0.0.1', port, path: p, method: 'GET' }, opts || {}), (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (opts && opts.body) r.write(opts.body);
    r.end();
  });
}

const srv = control.start({ target: TMP, cliPath: fakeCli, port: 0 });
let port = null;

async function main() {
  await new Promise((res) => srv.server.on('listening', () => { port = srv.server.address().port; res(); }));
  const token = srv.token;

  t('token 存到 <state>/control.json 且 0600', () => {
    const st = JSON.parse(fs.readFileSync(control.stateFile(TMP), 'utf8'));
    assert.strictEqual(st.token, token);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(control.stateFile(TMP)).mode & 0o777, 0o600);
  });

  let r = await req(port, '/api/health', { headers: {} });
  t('不带 token → 401', () => assert.strictEqual(r.status, 401));

  r = await req(port, '/api/health', { headers: { 'x-purge-token': 'nope' } });
  t('token 错 → 401', () => assert.strictEqual(r.status, 401));

  r = await req(port, '/api/health', { headers: { 'x-purge-token': token } });
  t('token 对 → health 里列出白名单动作', () => {
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.deepStrictEqual(j.actions.sort(), ['apply', 'report', 'revert', 'verify']);
  });

  r = await req(port, '/api/action', { method: 'POST', headers: { 'x-purge-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rm-rf' }) });
  t('非白名单动作 → 400', () => assert.strictEqual(r.status, 400));

  r = await req(port, '/api/action', { method: 'POST', headers: { 'x-purge-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revert' }) });
  t('revert 动作真的跑了 CLI 并带回输出', () => {
    const j = JSON.parse(r.body);
    assert.strictEqual(j.ok, true);
    assert.ok(j.output.includes('reverted'), j.output);
  });

  r = await req(port, '/api/report', { headers: { 'x-purge-token': token } });
  t('/api/report 返回 HTML（面板「刷新」用它换 srcdoc）', () => {
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('FAKE REPORT'), r.body.slice(0, 120));
  });
}

main().then(() => {
  srv.server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
